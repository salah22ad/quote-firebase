const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// ترجمة الرسائل للغات المختلفة
const messages = {
    ar: {
        success: 'تم حذف حسابك بنجاح. نأسف لرحيلك!',
        error: 'حدث خطأ أثناء حذف الحساب. يرجى المحاولة مرة أخرى أو التواصل مع الدعم.',
        notFound: 'لم يتم العثور على الحساب.',
        confirm: 'هل أنت متأكد تماماً من أنك تريد حذف حسابك نهائياً؟ هذه العملية لا يمكن التراجع عنها.'
    },
    en: {
        success: 'Your account has been successfully deleted. We\'re sorry to see you go!',
        error: 'An error occurred while deleting the account. Please try again or contact support.',
        notFound: 'Account not found.',
        confirm: 'Are you absolutely sure you want to permanently delete your account? This process cannot be undone.'
    },
    fr: {
        success: 'Votre compte a été supprimé avec succès. Nous sommes désolés de vous voir partir!',
        error: 'Une erreur s\'est produite lors de la suppression du compte. Veuillez réessayer ou contacter le support.',
        notFound: 'Compte non trouvé.',
        confirm: 'Êtes-vous absolument sûr de vouloir supprimer définitivement votre compte ? Ce processus ne peut pas être annulé.'
    },
    es: {
        success: 'Su cuenta ha sido eliminada exitosamente. ¡Lamentamos verle irse!',
        error: 'Ocurrió un error al eliminar la cuenta. Por favor, inténtelo de nuevo o contacte al soporte.',
        notFound: 'Cuenta no encontrada.',
        confirm: '¿Está absolutamente seguro de que desea eliminar permanentemente su cuenta? Este proceso no se puede deshacer.'
    },
    de: {
        success: 'Ihr Konto wurde erfolgreich gelöscht. Es tut uns leid, dass Sie gehen!',
        error: 'Beim Löschen des Kontos ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut ou kontaktieren Sie den Support.',
        notFound: 'Konto nicht gefunden.',
        confirm: 'Sind Sie absolut sicher, dass Sie Ihr Konto dauerhaft löschen möchten? Dieser Vorgang kann nicht rückgängig gemacht werden.'
    },
    tr: {
        success: 'Hesabınız başarıyla silindi. Gittiğiniz için üzgünüz!',
        error: 'Hesap silinirken bir hata oluştu. Lütfen tekrar deneyin veya destekle iletişime geçin.',
        notFound: 'Hesap bulunamadı.',
        confirm: 'Hesabınızı kalıcı olarak silmek istediğinizden kesinlikle emin misiniz? Bu işlem geri alınamaz.'
    },
    ru: {
        success: 'Ваш аккаунт был успешно удален. Нам жаль, что вы уходите!',
        error: 'Произошла ошибка при удалении аккаунта. Пожалуйста, попробуйте снова или свяжитесь с поддержкой.',
        notFound: 'Аккаунт не найден.',
        confirm: 'Вы абсолютно уверены, что хотите навсегда удалить свой аккаунт? Этот процесс нельзя отменить.'
    }
};

// دالة حذف الحساب
exports.deleteUserAccount = functions.https.onCall(async (data, context) => {
    // التحقق من المصادقة
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
    }

    const uid = data.uid;
    const userLanguage = data.language || 'en';
    
    // التحقق من UID
    if (!uid) {
        return {
            success: false,
            error: messages[userLanguage]?.notFound || 'User ID is required'
        };
    }

    // التحقق من أن المستخدم يحاول حذف حسابه فقط
    if (context.auth.uid !== uid) {
        throw new functions.https.HttpsError('permission-denied', 'غير مصرح بحذف حسابات أخرى');
    }

    try {
        // 1. الحصول على بيانات المستخدم قبل الحذف
        let userEmail = 'unknown';
        try {
            const userRecord = await admin.auth().getUser(uid);
            userEmail = userRecord.email || 'unknown';
        } catch (error) {
            console.warn('Could not fetch user data from Auth:', error);
        }

        // 2. حذف مستند المستخدم من مجموعة users
        await admin.firestore().collection('users').doc(uid).delete();
        console.log('User document deleted successfully');

        // 3. حذف الإشعارات المرتبطة بالمستخدم من مجموعة referral_notifications
        const notificationsQuery = admin.firestore().collection('referral_notifications')
            .where('targetUid', '==', uid);
        
        const notificationsSnapshot = await notificationsQuery.get();
        const deleteNotificationsPromises = notificationsSnapshot.docs.map(doc => 
            doc.ref.delete()
        );
        await Promise.all(deleteNotificationsPromises);
        console.log('Referral notifications deleted successfully');

        // 4. حذف جميع البيانات الأخرى المرتبطة بالمستخدم
        // يمكنك إضافة المزيد من عمليات الحذف هنا حسب هيكل بياناتك

        // 5. حذف المستخدم من Authentication
        await admin.auth().deleteUser(uid);
        console.log('User deleted from Authentication');

        // 6. إضافة سجل الحذف في مجموعة deletionLogs
        await admin.firestore().collection('deletionLogs').add({
            userId: uid,
            email: userEmail,
            language: userLanguage,
            deleted_at: admin.firestore.FieldValue.serverTimestamp(),
            type: 'user_initiated',
            status: 'completed'
        });
        console.log('Deletion log added successfully');

        return { 
            success: true, 
            message: messages[userLanguage]?.success || 'Account deleted successfully',
            email: userEmail,
            language: userLanguage
        };
        
    } catch (error) {
        console.error('Error deleting account:', error);
        
        // تسجيل فشل الحذف
        try {
            await admin.firestore().collection('deletionLogs').add({
                userId: uid,
                email: 'unknown',
                language: userLanguage,
                deleted_at: admin.firestore.FieldValue.serverTimestamp(),
                type: 'user_initiated',
                status: 'failed',
                error_message: error.message
            });
        } catch (logError) {
            console.error('Error logging failed deletion:', logError);
        }
        
        return { 
            success: false, 
            error: messages[userLanguage]?.error || error.message 
        };
    }
});

// دالة للتحقق من حالة الحساب قبل التسجيل
exports.checkUserDeletionStatus = functions.https.onCall(async (data, context) => {
  const { email } = data;

  if (!email) {
    throw new functions.https.HttpsError('invalid-argument', 'البريد الإلكتروني مطلوب');
  }

  try {
    const db = admin.firestore();
    
    // البحث في deletionLogs باستخدام البريد الإلكتروني
    const deletionLogsRef = db.collection('deletionLogs');
    const snapshot = await deletionLogsRef
      .where('email', '==', email.toLowerCase())
      .where('status', '==', 'completed')
      .orderBy('deleted_at', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return { 
        isDeleted: false,
        message: 'الحساب نشط'
      };
    } else {
      const deletionData = snapshot.docs[0].data();
      return { 
        isDeleted: true,
        message: 'تم حذف هذا الحساب',
        deletionDate: deletionData.deleted_at,
        reason: deletionData.reason
      };
    }
  } catch (error) {
    console.error('Error checking user deletion status:', error);
    throw new functions.https.HttpsError('internal', 'خطأ في التحقق من حالة الحساب');
  }
});