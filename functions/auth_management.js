const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const messages = {
  ar: {
    success: "تم حذف حسابك بنجاح. نأسف لرحيلك!",
    error: "حدث خطأ أثناء حذف الحساب. يرجى المحاولة مرة أخرى أو التواصل مع الدعم.",
    notFound: "لم يتم العثور على الحساب.",
  },
  en: {
    success: "Your account has been successfully deleted. We're sorry to see you go!",
    error: "An error occurred while deleting the account. Please try again or contact support.",
    notFound: "Account not found.",
  },
  fr: {
    success: "Votre compte a été supprimé avec succès. Nous sommes désolés de vous voir partir!",
    error: "Une erreur s'est produite lors de la suppression du compte. Veuillez réessayer ou contacter le support.",
    notFound: "Compte non trouvé.",
  },
  es: {
    success: "Su cuenta ha sido eliminada exitosamente. ¡Lamentamos verle irse!",
    error: "Ocurrió un error al eliminar la cuenta. Por favor, inténtelo de nuevo o contacte al soporte.",
    notFound: "Cuenta no encontrada.",
  },
  de: {
    success: "Ihr Konto wurde erfolgreich gelöscht. Es tut uns leid, dass Sie gehen!",
    error: "Beim Löschen des Kontos ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut oder kontaktieren Sie den Support.",
    notFound: "Konto nicht gefunden.",
  },
  tr: {
    success: "Hesabınız başarıyla silindi. Gittiğiniz için üzgünüz!",
    error: "Hesap silinirken bir hata oluştu. Lütfen tekrar deneyin veya destekle iletişime geçin.",
    notFound: "Hesap bulunamadı.",
  },
  ru: {
    success: "Ваш аккаунт был успешно удален. Нам жаль, что вы уходите!",
    error: "Произошла ошибка при удалении аккаунта. Пожалуйста, попробуйте снова или свяжитесь с поддержкой.",
    notFound: "Аккаунт не найден.",
  },
};

function getMessage(language, key) {
  if (messages[language] && messages[language][key]) {
    return messages[language][key];
  }
  return messages.en[key] || key;
}

exports.deleteUserAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً");
  }

  const uid = data.uid;
  const userLanguage = data.language || "en";

  if (!uid) {
    return {
      success: false,
      error: getMessage(userLanguage, "notFound"),
    };
  }

  if (context.auth.uid !== uid) {
    throw new functions.https.HttpsError("permission-denied", "غير مصرح بحذف حسابات أخرى");
  }

  try {
    let userEmail = "unknown";
    try {
      const userRecord = await admin.auth().getUser(uid);
      userEmail = userRecord.email || "unknown";
    } catch (error) {
      console.warn("Could not fetch user data from Auth:", error);
    }

    await admin.firestore().collection("users").doc(uid).delete();

    const notificationsQuery = admin.firestore().collection("referral_notifications")
        .where("targetUid", "==", uid);
    const notificationsSnapshot = await notificationsQuery.get();
    await Promise.all(notificationsSnapshot.docs.map((doc) => doc.ref.delete()));

    await admin.auth().deleteUser(uid);

    await admin.firestore().collection("deletionLogs").add({
      userId: uid,
      email: userEmail,
      language: userLanguage,
      deleted_at: admin.firestore.FieldValue.serverTimestamp(),
      type: "user_initiated",
      status: "completed",
    });

    return {
      success: true,
      message: getMessage(userLanguage, "success"),
      email: userEmail,
      language: userLanguage,
    };
  } catch (error) {
    console.error("Error deleting account:", error);
    try {
      await admin.firestore().collection("deletionLogs").add({
        userId: uid,
        email: "unknown",
        language: userLanguage,
        deleted_at: admin.firestore.FieldValue.serverTimestamp(),
        type: "user_initiated",
        status: "failed",
        error_message: error.message,
      });
    } catch (logError) {
      console.error("Error logging failed deletion:", logError);
    }

    return {
      success: false,
      error: getMessage(userLanguage, "error"),
    };
  }
});

exports.checkUserDeletionStatus = functions.https.onCall(async (data, context) => {
  const { email } = data;
  if (!email) {
    throw new functions.https.HttpsError("invalid-argument", "البريد الإلكتروني مطلوب");
  }

  try {
    const db = admin.firestore();
    const snapshot = await db.collection("deletionLogs")
        .where("email", "==", email.toLowerCase())
        .where("status", "==", "completed")
        .orderBy("deleted_at", "desc")
        .limit(1)
        .get();

    if (snapshot.empty) {
      return {
        isDeleted: false,
        message: "الحساب نشط",
      };
    } else {
      const deletionData = snapshot.docs[0].data();
      return {
        isDeleted: true,
        message: "تم حذف هذا الحساب",
        deletionDate: deletionData.deleted_at,
        reason: deletionData.reason,
      };
    }
  } catch (error) {
    console.error("Error checking user deletion status:", error);
    throw new functions.https.HttpsError("internal", "خطأ في التحقق من حالة الحساب");
  }
});
