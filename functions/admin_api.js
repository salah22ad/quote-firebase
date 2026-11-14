const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * فحص ذكي وشامل لصلاحية المدير:
 * 1. يفحص admins/{uid}
 * 2. يفحص users/{uid}
 * 3. إذا أنشأ المدير مستنداً بمعرّف عشوائي (Auto-ID) في admins أو users يحتوي على بريده و userType="admin"،
 *    يقوم السيرفر تلقائياً بتثبيته في admins/{uid} وتنظيف المستند الناقص من users.
 */
async function resolveAdminStatus(uid, tokenEmail) {
  const email = (tokenEmail || '').toLowerCase().trim();

  // 1. فحص مجموعة admins بالـ UID مباشرة
  const adminDoc = await db.collection('admins').doc(uid).get();
  if (adminDoc.exists && adminDoc.data().userType === 'admin') {
    return { isAdmin: true, uid, email: adminDoc.data().email || email };
  }

  // 2. فحص مجموعة users بالـ UID مباشرة
  const userDoc = await db.collection('users').doc(uid).get();
  if (userDoc.exists && userDoc.data().userType === 'admin') {
    return { isAdmin: true, uid, email: userDoc.data().email || email };
  }

  // 3. فحص بالبريد الإلكتروني في حال تم إنشاء المستند يدوياً بـ Auto-ID
  if (email) {
    // بحث في مجموعة admins بالبريد
    const adminByEmail = await db.collection('admins')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!adminByEmail.empty && adminByEmail.docs[0].data().userType === 'admin') {
      const foundDoc = adminByEmail.docs[0];
      await db.collection('admins').doc(uid).set({
        uid,
        email,
        userType: 'admin',
        created_at: new Date().toISOString()
      }, { merge: true });
      if (foundDoc.id !== uid) {
        await foundDoc.ref.delete().catch(() => {});
      }
      return { isAdmin: true, uid, email };
    }

    // بحث في مجموعة users بالبريد (مثل مستند gPgdC04bPcaIOt0w5WsX)
    const userByEmail = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!userByEmail.empty && userByEmail.docs[0].data().userType === 'admin') {
      const foundDoc = userByEmail.docs[0];
      const foundData = foundDoc.data();

      // إنشاء مستند المدير المعتمد في مجموعة admins/{uid}
      await db.collection('admins').doc(uid).set({
        uid,
        email,
        userType: 'admin',
        name: foundData.name || foundData.display_name || 'Admin',
        created_at: new Date().toISOString()
      }, { merge: true });

      // إذا كان المستند في users بمعرّف عشوائي ولا يحتوي على بيانات تطبيق حقيقية (devices)، نحذفه من users
      if (foundDoc.id !== uid && !foundData.devices) {
        await foundDoc.ref.delete().catch(() => {});
      }
      return { isAdmin: true, uid, email };
    }
  }

  return { isAdmin: false, uid, email };
}

async function assertAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }
  const status = await resolveAdminStatus(context.auth.uid, context.auth.token.email);
  if (!status.isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'ليست لديك صلاحية الوصول (مطلوب userType=admin)');
  }
  return { uid: status.uid, email: status.email };
}

function ok(data) { return { success: true, ...data }; }
function fail(message, code = 'internal') {
  throw new functions.https.HttpsError(code, message);
}

// ============================================================
//  1) checkIsAdmin — للتحقق من الصلاحية عند تسجيل الدخول
// ============================================================
exports.checkIsAdmin = functions.https.onCall(async (data, context) => {
  if (!context.auth) return { isAdmin: false };
  try {
    const status = await resolveAdminStatus(context.auth.uid, context.auth.token.email);
    return { isAdmin: status.isAdmin, email: status.email };
  } catch (e) {
    console.error('checkIsAdmin error:', e);
    return { isAdmin: false };
  }
});

// ============================================================
//  2) getDashboardSummary — ملخص الصفحة الرئيسية
// ============================================================
exports.getDashboardSummary = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  try {
    const [usersSnap, guestsSnap, premiumSnap] = await Promise.all([
      db.collection('users').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection('guests').count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection('users').where('is_premium', '==', true).count().get().catch(() => ({ data: () => ({ count: 0 }) }))
    ]);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStr = startOfDay.toISOString().slice(0, 19).replace('T', ' ');

    const [newUsers, newGuests] = await Promise.all([
      db.collection('users').where('created_at', '>=', todayStr).count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection('guests').where('created_at', '>=', todayStr).count().get().catch(() => ({ data: () => ({ count: 0 }) }))
    ]);

    return ok({
      totalUsers: usersSnap.data().count,
      totalGuests: guestsSnap.data().count,
      premiumUsers: premiumSnap.data().count,
      newUsersToday: newUsers.data().count + newGuests.data().count
    });
  } catch (e) {
    fail('فشل تحميل الملخص: ' + e.message);
  }
});

// ============================================================
//  3) getUserStats — إحصائيات المستخدمين التفصيلية
// ============================================================
exports.getUserStats = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  try {
    const [usersSnap, guestsSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('guests').get().catch(() => ({ size: 0, docs: [] }))
    ]);

    const totalUsers = usersSnap.size;
    const totalGuests = guestsSnap.size;
    const totalAccounts = totalUsers + totalGuests;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfDayString = startOfDay.toISOString().slice(0, 19).replace('T', ' ');

    const [newUsersToday, newGuestsToday] = await Promise.all([
      db.collection('users').where('created_at', '>=', startOfDayString).get().then(s => s.size).catch(() => 0),
      db.collection('guests').where('created_at', '>=', startOfDayString).get().then(s => s.size).catch(() => 0)
    ]);

    const premiumSnap = await db.collection('users').where('is_premium', '==', true).get().catch(() => ({ size: 0 }));
    const premiumCount = premiumSnap.size;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 19).replace('T', ' ');

    const activeSnap = await db.collection('users')
      .where('last_login', '>=', sevenDaysAgoStr)
      .get()
      .catch(() => ({ size: 0 }));

    return ok({
      totalUsers,
      totalGuests,
      totalAccounts,
      newUsersToday: newUsersToday + newGuestsToday,
      newUsersRegistered: newUsersToday,
      newGuestsToday,
      premiumCount,
      activeUsers: activeSnap.size
    });
  } catch (e) {
    console.error('getUserStats error:', e);
    fail('فشل تحميل الإحصائيات: ' + e.message);
  }
});

// ============================================================
//  4) getAllUsers — قائمة المشتركين (مع قراءة Quotes_count بدقة)
// ============================================================
exports.getAllUsers = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { limit = 200, search = '', premiumOnly = false } = data || {};

  try {
    const snapshot = await db.collection('users').get();
    let users = snapshot.docs.map(doc => {
      const d = doc.data();
      const quotesCount = Math.max(
        Number(d.Quotes_count || 0),
        Number(d.quotes_count || 0),
        Number(d.quotesCount || 0)
      );
      return {
        id: doc.id,
        email: d.email || '',
        displayName: d.display_name || d.displayName || d.name || '',
        is_premium: d.is_premium || false,
        plan_type: d.plan_type || '',
        quotes_count: quotesCount,
        max_quotes: d.max_quotes ?? 0,
        created_at: d.created_at || ''
      };
    });

    // ترتيب تنازلي حسب تاريخ التسجيل
    users.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    if (premiumOnly) {
      users = users.filter(u => u.is_premium);
    }

    if (search) {
      const s = search.toLowerCase();
      users = users.filter(u =>
        (u.email || '').toLowerCase().includes(s) ||
        (u.displayName || '').toLowerCase().includes(s) ||
        (u.id || '').toLowerCase().includes(s)
      );
    }

    users = users.slice(0, Math.min(parseInt(limit) || 200, 500));
    return ok({ users, count: users.length });
  } catch (e) {
    console.error('getAllUsers error:', e);
    fail('فشل جلب المستخدمين: ' + e.message);
  }
});

// ============================================================
//  5) activateUserPremium — تفعيل/تمديد البريميوم
// ============================================================
exports.activateUserPremium = functions.https.onCall(async (data, context) => {
  const adminUser = await assertAdmin(context);
  const { email, planType, months = 1 } = data;

  if (!email) fail('البريد الإلكتروني مطلوب', 'invalid-argument');
  if (!planType) fail('نوع الخطة مطلوب', 'invalid-argument');

  try {
    const userQuery = await db.collection('users').where('email', '==', email.toLowerCase().trim()).limit(1).get();
    if (userQuery.empty) fail('لم يتم العثور على مستخدم بهذا البريد', 'not-found');

    const userDoc = userQuery.docs[0];
    const userId = userDoc.id;
    const userData = userDoc.data();

    const now = new Date();
    const expiry = new Date();

    if (planType === 'lifetime') {
      expiry.setFullYear(expiry.getFullYear() + 99);
    } else if (planType === 'monthly-manual') {
      expiry.setMonth(expiry.getMonth() + parseInt(months));
    } else if (planType === 'yearly-manual') {
      expiry.setFullYear(expiry.getFullYear() + 1);
    } else {
      fail('نوع خطة غير صالح', 'invalid-argument');
    }

    const updates = {
      is_premium: true,
      plan_type: planType,
      subscription_expiry: admin.firestore.Timestamp.fromDate(expiry),
      subscription_start: admin.firestore.FieldValue.serverTimestamp(),
      lastModified: Date.now(),
      subscriptionStatus: 'activated',
      premium_activated_at: now.toISOString(),
      premium_activated_by: adminUser.email
    };

    if (!userData.first_subscription_date) {
      updates.first_subscription_date = admin.firestore.FieldValue.serverTimestamp();
    }

    await db.collection('users').doc(userId).update(updates);

    return ok({
      message: 'تم تفعيل البريميوم بنجاح',
      userId,
      expiry: expiry.toISOString(),
      planType
    });
  } catch (e) {
    console.error('activateUserPremium error:', e);
    fail('فشل التفعيل: ' + e.message);
  }
});

// ============================================================
//  6) getUsersWithDevices & deleteUserDevice — إدارة الأجهزة
// ============================================================
exports.getUsersWithDevices = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  try {
    const usersSnap = await db.collection('users').get();
    const usersList = [];

    for (const doc of usersSnap.docs) {
      const userData = doc.data();
      const devicesMap = userData.devices;
      if (!devicesMap || Object.keys(devicesMap).length <= 1) continue;

      const devices = Object.entries(devicesMap).map(([deviceId, deviceInfo]) => ({
        deviceId: deviceId,
        deviceName: deviceInfo.deviceName || 'غير معروف',
        lastActiveAt: deviceInfo.lastActiveAt || null,
        active: deviceInfo.active || false
      }));

      const quotesCount = Math.max(
        Number(userData.Quotes_count || 0),
        Number(userData.quotes_count || 0),
        Number(userData.quotesCount || 0)
      );

      usersList.push({
        uid: doc.id,
        email: userData.email || '',
        displayName: userData.display_name || userData.displayName || userData.name || '',
        is_premium: userData.is_premium || false,
        quotes_count: quotesCount,
        created_at: userData.created_at || null,
        devices: devices
      });
    }

    usersList.sort((a, b) => b.devices.length - a.devices.length);
    return ok({ users: usersList });
  } catch (e) {
    console.error('getUsersWithDevices error:', e);
    fail('فشل جلب بيانات الأجهزة: ' + e.message);
  }
});

exports.deleteUserDevice = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { uid, deviceId } = data;
  if (!uid || !deviceId) fail('uid و deviceId مطلوبان', 'invalid-argument');

  if (deviceId.includes('.') || deviceId.includes('[') || deviceId.includes(']')) {
    fail('deviceId يحتوي على أحرف غير مسموحة', 'invalid-argument');
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) fail('المستخدم غير موجود', 'not-found');

    const devices = userDoc.data().devices;
    if (!devices || !devices[deviceId]) {
      fail('الجهاز غير موجود', 'not-found');
    }

    await userRef.update({
      [`devices.${deviceId}`]: admin.firestore.FieldValue.delete(),
      lastModified: Date.now()
    });

    return ok({ success: true, message: 'تم حذف الجهاز بنجاح' });
  } catch (e) {
    console.error('deleteUserDevice error:', e);
    fail('فشل حذف الجهاز: ' + e.message);
  }
});

// ============================================================
//  7) fixMaxQuotes — تحديث جماعي لـ max_quotes (users أو guests، الافتراضي 100)
// ============================================================
exports.fixMaxQuotes = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);

  const targetCollection = data.collection === 'guests' ? 'guests' : 'users';
  const maxValue = data.maxValue !== undefined ? parseInt(data.maxValue) : 100;

  if (isNaN(maxValue) || maxValue < 1) {
    fail('قيمة max_quotes يجب أن تكون رقماً موجباً', 'invalid-argument');
  }

  try {
    const snap = await db.collection(targetCollection).get();
    const BATCH_LIMIT = 500;
    let updated = 0;
    let skipped = 0;

    const toUpdate = snap.docs.filter(doc => {
      const isPremium = doc.get('is_premium');
      const activatedBy = doc.get('premium_activated_by');
      const currentMax = doc.get('max_quotes');
      const currentMaxValue = (currentMax !== undefined && typeof currentMax === 'number') ? currentMax : 0;

      const condition = targetCollection === 'guests'
        ? true
        : ((isPremium === false || isPremium === undefined) || (activatedBy === 'Google Ads'));

      const needUpdate = condition && (currentMaxValue < maxValue);
      if (!needUpdate && condition) skipped++;
      return needUpdate;
    });

    for (let i = 0; i < toUpdate.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      toUpdate.slice(i, i + BATCH_LIMIT).forEach(doc => {
        batch.update(doc.ref, {
          max_quotes: maxValue,
          lastModified: Date.now()
        });
        updated++;
      });
      await batch.commit();
    }

    return ok({
      collection: targetCollection,
      updated,
      total: snap.size,
      skipped,
      maxValue,
      message: `تم تحديث ${updated} سجل في (${targetCollection}) إلى ${maxValue} (تم تخطي ${skipped})`
    });
  } catch (e) {
    console.error('fixMaxQuotes error:', e);
    fail('فشل التحديث الجماعي: ' + e.message);
  }
});

// ============================================================
//  8) updateUserMaxQuotes — تحديث فردي لـ max_quotes (users أو guests)
// ============================================================
exports.updateUserMaxQuotes = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);

  const targetCollection = data.collection === 'guests' ? 'guests' : 'users';
  const identifier = (data.identifier || data.email || '').trim();
  const newMax = data.maxValue !== undefined ? parseInt(data.maxValue) : 100;

  if (!identifier) {
    fail(targetCollection === 'guests' ? 'معرّف الضيف (guestUID) مطلوب' : 'البريد الإلكتروني مطلوب', 'invalid-argument');
  }
  if (isNaN(newMax) || newMax < 1) {
    fail('قيمة max_quotes يجب أن تكون رقماً موجباً', 'invalid-argument');
  }

  try {
    let targetDoc = null;

    if (targetCollection === 'users') {
      const userQuery = await db.collection('users')
        .where('email', '==', identifier.toLowerCase())
        .limit(1)
        .get();
      if (userQuery.empty) fail('لم يتم العثور على مستخدم بهذا البريد', 'not-found');
      targetDoc = userQuery.docs[0];
    } else {
      const guestDirect = await db.collection('guests').doc(identifier).get();
      if (guestDirect.exists) {
        targetDoc = guestDirect;
      } else {
        const guestQuery = await db.collection('guests')
          .where('ownerUID', '==', identifier)
          .limit(1)
          .get();
        if (guestQuery.empty) fail('لم يتم العثور على ضيف بهذا المعرّف', 'not-found');
        targetDoc = guestQuery.docs[0];
      }
    }

    const currentMax = targetDoc.get('max_quotes');
    const oldValue = (currentMax !== undefined && typeof currentMax === 'number') ? currentMax : 0;

    await targetDoc.ref.update({
      max_quotes: newMax,
      lastModified: Date.now()
    });

    return ok({
      success: true,
      collection: targetCollection,
      docId: targetDoc.id,
      identifier,
      oldMax: oldValue,
      newMax,
      message: `تم تحديث max_quotes في (${targetCollection}) من ${oldValue} إلى ${newMax}`
    });
  } catch (e) {
    console.error('updateUserMaxQuotes error:', e);
    fail('فشل التحديث: ' + e.message);
  }
});

// ============================================================
//  9) sendGeneralNotificationCampaign — إرسال الإشعار المترجم
// ============================================================
exports.sendGeneralNotificationCampaign = functions.https.onCall(async (data, context) => {
  await assertAdmin(context);
  const {
    title,
    body,
    type = 'MainActivity',
    webUrl = '',
    audience = 'global'
  } = data || {};

  if (!title || !body) {
    fail('عنوان الإشعار ونص الرسالة مطلوبان', 'invalid-argument');
  }

  const collection = audience === 'admins'
    ? 'admin_notifications'
    : 'global_translate_notifications';

  const docData = {
    title: String(title).trim(),
    message: String(body).trim(),
    type: String(type || 'MainActivity').trim(),
    webUrl: String(webUrl || '').trim(),
    senderId: context.auth.uid,
    senderEmail: context.auth.token.email || '',
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    const ref = await db.collection(collection).add(docData);
    return ok({
      message: audience === 'admins'
        ? 'تم إرسال الإشعار التجريبي للإدارة بنجاح'
        : 'تم إطلاق الإشعار وترجمته لجميع المستخدمين بنجاح',
      docId: ref.id,
      collection
    });
  } catch (e) {
    console.error('sendGeneralNotificationCampaign error:', e);
    fail('فشل إرسال الإشعار: ' + e.message);
  }
});
