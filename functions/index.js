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

// 3) دالة الإشعارات العامة المترجمة (مطابقة لمبدأ محفظتي)
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

    // اللغات المعتمدة للترجمة
    const targetLanguages = ['en', 'de', 'fr', 'es', 'ru', 'hi', 'zh', 'tr'];
    let arabicSent = false;
    let successCount = 0;

    try {
      // 1. إرسال الإشعار العربي الأصلي لقناة global_ar
      try {
        await admin.messaging().send({
          data: {
            title: originalTitle,
            message: originalMessage,
            type: type,
            webUrl: webUrl
          },
          android: { priority: 'high' },
          topic: 'global_ar'
        });
        arabicSent = true;
        console.log(`✅ [${docId}] Arabic notification sent to topic global_ar`);
      } catch (arError) {
        console.error(`❌ [${docId}] Failed to send Arabic:`, arError.message);
      }

      // 2. ترجمة وإرسال بقية اللغات
      for (const lang of targetLanguages) {
        try {
          const [translations] = await translate.translate(
            [originalTitle, originalMessage],
            lang
          );

          await admin.messaging().send({
            data: {
              title: translations[0] || originalTitle,
              message: translations[1] || originalMessage,
              type: type,
              webUrl: webUrl
            },
            android: { priority: 'high' },
            topic: `global_${lang}`
          });
          successCount++;
          console.log(`✅ [${docId}] Sent to topic global_${lang}`);
        } catch (langError) {
          console.error(`❌ [${docId}] Error for language ${lang}:`, langError.message);
        }
      }

      // 3. حذف الوثيقة بعد المعالجة لمنع تكرارها
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
          title: title,
          message: message,
          type: type,
          webUrl: webUrl
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
