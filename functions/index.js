const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const { Translate } = require('@google-cloud/translate').v2;

const translate = new Translate();

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// 1) استيراد دوال إدارة الحسابات (deleteUserAccount & checkUserDeletionStatus)
try {
  const authManagement = require('./auth_management');
  exports.deleteUserAccount = authManagement.deleteUserAccount;
  exports.checkUserDeletionStatus = authManagement.checkUserDeletionStatus;
} catch (e) {
  console.log('تنبيه: ملف auth_management.js غير موجود.');
}

// 2) استيراد دوال Admin Web Panel
try {
  const adminApi = require('./admin_api');
  Object.keys(adminApi).forEach(key => {
    exports[key] = adminApi[key];
  });
} catch (e) {
  console.error('فشل تحميل admin_api.js:', e);
}

/**
 * تحويل رمز القناة إلى الرمز القياسي لمحرك ترجمة جوجل
 */
function toTranslateApiCode(topicLang) {
  if (topicLang === 'zh') return 'zh-CN';
  if (topicLang === 'iw') return 'he';
  return topicLang;
}

/**
 * دالة ترجمة مزدوجة:
 * 1. تستخدم Google Cloud Translation API الرسمي
 * 2. في حال عدم تفعيله، تستخدم محرك Google GTX المجاني تلقائياً
 * 3. في حال تعذر الاتصال، تعيد النص الأصلي لضمان وصول الإشعار دائماً
 */
async function translateTitleAndMessage(originalTitle, originalMessage, topicLang) {
  const apiLang = toTranslateApiCode(topicLang);

  try {
    const [translations] = await translate.translate(
      [originalTitle, originalMessage],
      apiLang
    );
    if (translations && translations[0] && translations[1]) {
      return { title: translations[0], message: translations[1] };
    }
  } catch (cloudErr) {
    console.warn(`⚠️ Cloud Translate fallback for [${topicLang}]:`, cloudErr.message);
  }

  try {
    const translateSingleGtx = async (text) => {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=${apiLang}&dt=t&q=${encodeURIComponent(text)}`;
      const response = await fetch(url);
      if (!response.ok) return text;
      const data = await response.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data[0].map(item => (item && item[0]) ? item[0] : '').join('').trim() || text;
      }
      return text;
    };

    const [fallbackTitle, fallbackMessage] = await Promise.all([
      translateSingleGtx(originalTitle),
      translateSingleGtx(originalMessage)
    ]);

    return {
      title: fallbackTitle || originalTitle,
      message: fallbackMessage || originalMessage
    };
  } catch (fallbackErr) {
    console.error(`⚠️ Fallback failed for [${topicLang}], using original:`, fallbackErr.message);
    return { title: originalTitle, message: originalMessage };
  }
}

// 3) دالة الإشعارات العامة المترجمة لـ 29 لغة (العربية + 27 لغة مترجمة، والافتراضي global_en)
exports.sendGeneralTralatedNotification = functions.firestore
  .document('global_translate_notifications/{docId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data();
    const docId = context.params.docId;

    const originalTitle = data.title || data.originalTitle;
    const originalMessage = data.message || data.originalMessage || data.body;
    const type = data.type || 'MainActivity';
    const webUrl = data.webUrl || '';

    if (!originalTitle || !originalMessage) {
      console.error(`❌ [${docId}] Missing title or message. Deleting document.`);
      await snapshot.ref.delete();
      return null;
    }

    // اللغات الـ 27 المترجم إليها (بالإضافة إلى العربية global_ar = 28 قناة تغطي الـ 29 لغة في المتجر)
    const targetLanguages = [
      'en', 'cs', 'da', 'de', 'es', 'fi', 'fr', 'hi', 'hu',
      'id', 'it', 'iw', 'ja', 'ko', 'nl', 'no', 'pl', 'pt',
      'ro', 'ru', 'sk', 'sv', 'th', 'tr', 'uk', 'vi', 'zh'
    ];

    let arabicSent = false;
    let successCount = 0;

    try {
      // 1. إرسال الإشعار العربي الأصلي لقناة global_ar
      try {
        await admin.messaging().send({
          data: {
            title: String(originalTitle),
            message: String(originalMessage),
            type: String(type),
            webUrl: String(webUrl)
          },
          android: { priority: 'high' },
          topic: 'global_ar'
        });
        arabicSent = true;
        console.log(`✅ [${docId}] Sent Arabic to topic global_ar`);
      } catch (arError) {
        console.error(`❌ [${docId}] Failed to send Arabic:`, arError.message);
      }

      // 2. ترجمة وإرسال اللغات الـ 27 على دفعات متوازية (7 لغات في كل دفعة لسرعة الإنجاز)
      const BATCH_SIZE = 7;
      for (let i = 0; i < targetLanguages.length; i += BATCH_SIZE) {
        const chunk = targetLanguages.slice(i, i + BATCH_SIZE);
        await Promise.all(chunk.map(async (lang) => {
          try {
            const translated = await translateTitleAndMessage(originalTitle, originalMessage, lang);
            await admin.messaging().send({
              data: {
                title: String(translated.title || originalTitle),
                message: String(translated.message || originalMessage),
                type: String(type),
                webUrl: String(webUrl)
              },
              android: { priority: 'high' },
              topic: `global_${lang}`
            });
            successCount++;
            console.log(`✅ [${docId}] Sent to topic global_${lang}`);
          } catch (langError) {
            console.error(`❌ [${docId}] Error sending to global_${lang}:`, langError.message);
          }
        }));
      }

      // 3. حذف الوثيقة بعد اكتمال البث
      await snapshot.ref.delete();
      console.log(`✅ [${docId}] Completed. Arabic: ${arabicSent}, Translated: ${successCount}/${targetLanguages.length}`);
      return null;
    } catch (fatalError) {
      console.error(`❌ [${docId}] Fatal error:`, fatalError);
      return null;
    }
  });

// 4) دالة إشعارات المدراء التجريبية (بدون ترجمة)
exports.sendAdminTranslateNotification = functions.firestore
  .document('admin_notifications/{docId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data();
    const title = data.originalTitle || data.title || '';
    const message = data.originalMessage || data.message || '';
    const type = data.type || 'MainActivity';
    const webUrl = data.webUrl || '';

    try {
      await admin.messaging().send({
        data: {
          title: String(title),
          message: String(message),
          type: String(type),
          webUrl: String(webUrl)
        },
        android: { priority: 'high' },
        topic: 'admins'
      });
      console.log('تم إرسال إشعار الإدارة بنجاح');
      return snapshot.ref.delete();
    } catch (error) {
      console.error('Error in sendAdminTranslateNotification:', error);
      return null;
    }
  });
