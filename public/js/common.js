import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFunctions, httpsCallable, connectFunctionsEmulator
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

// جلب إعدادات مشروع make-quotes-hpp تلقائياً من Firebase Hosting
let firebaseConfig;
try {
  const res = await fetch("/__/firebase/init.json");
  if (!res.ok) throw new Error("init.json not found");
  firebaseConfig = await res.json();
} catch (e) {
  firebaseConfig = {
    projectId: "make-quotes-hpp",
    authDomain: "make-quotes-hpp.firebaseapp.com"
  };
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, "us-central1");

const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
if (IS_LOCAL) {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

// عناصر القائمة الجانبية الخاصة بلوحة تحكم Quotes Pro (بدون Ghost Protocol وبدون حذف المستخدمين)
const NAV_ITEMS = [
  { group: "الرئيسية" },
  { href: "/", icon: "🏠", label: "لوحة التحكم" },

  { group: "إدارة المستخدمين" },
  { href: "/stats", icon: "📊", label: "إحصائيات المستخدمين" },
  { href: "/users", icon: "👥", label: "قائمة المشتركين" },
  { href: "/devices", icon: "📱", label: "فحص الأجهزة" },
  { href: "/premium", icon: "⭐", label: "تفعيل البريميوم" },

  { group: "الإشعارات والحصص" },
  { href: "/notifications", icon: "🔔", label: "إرسال إشعار مترجم" },
  { href: "/quota", icon: "🔧", label: "إدارة حصة العروض (max_quotes)" }
];

function buildSidebar(activePath) {
  const initial = (auth.currentUser?.email || "A").charAt(0).toUpperCase();
  const displayName = auth.currentUser?.displayName || "المدير";

  const navHTML = NAV_ITEMS.map(item => {
    if (item.group) {
      return `<div class="sidebar__nav-title">${item.group}</div>`;
    }
    const isActive = activePath === item.href;
    return `
      <a href="${item.href}" class="sidebar__link ${isActive ? "is-active" : ""}" data-link>
        <span class="sidebar__icon">${item.icon}</span>
        <span>${item.label}</span>
      </a>`;
  }).join("");

  return `
    <aside class="sidebar" id="sidebar">
      <div class="sidebar__brand">
        <div class="sidebar__logo">
          <img src="/images/app_icon.png" alt="Logo" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.textContent='Q';">
        </div>
        <div>
          <div class="sidebar__title">Quotes Pro Admin</div>
          <div class="sidebar__subtitle">لوحة إدارة عروض الأسعار</div>
        </div>
      </div>

      <nav class="sidebar__nav">
        ${navHTML}
      </nav>

      <div class="sidebar__user">
        <div class="sidebar__user-avatar">${initial}</div>
        <div class="sidebar__user-info">
          <div class="sidebar__user-name">${displayName}</div>
          <div class="sidebar__user-email">${auth.currentUser?.email || ""}</div>
        </div>
        <button class="sidebar__logout" id="btnLogout" title="تسجيل خروج">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
        </button>
      </div>
    </aside>`;
}

function buildHeader(title, subtitle = "") {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">${title}</h1>
        ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ""}
      </div>
      <div id="headerActions"></div>
    </div>`;
}

function mountShell(activePath, pageTitle, pageSubtitle) {
  const existing = document.getElementById("appShell");
  if (existing) existing.remove();

  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.id = "appShell";
  shell.innerHTML = `
    ${buildSidebar(activePath)}
    <main class="main" id="mainContent">
      ${buildHeader(pageTitle, pageSubtitle)}
      <div id="pageBody"></div>
    </main>
  `;

  document.body.insertBefore(shell, document.body.firstChild);

  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    try {
      await signOut(auth);
      location.href = "/login";
    } catch (e) {
      toast("فشل تسجيل الخروج", "error");
    }
  });
}

async function checkAdmin() {
  if (!auth.currentUser) return false;
  try {
    const checkFn = httpsCallable(functions, "checkIsAdmin");
    const result = await checkFn();
    return result.data && result.data.isAdmin === true;
  } catch (e) {
    console.error("Admin check failed:", e);
    return false;
  }
}

function requireAuth() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      if (!user) {
        location.href = "/login";
        return;
      }

      if (IS_LOCAL) {
        resolve(user);
        return;
      }

      const isAdmin = await checkAdmin();
      if (!isAdmin) {
        await signOut(auth);
        location.href = "/login?error=not_admin";
        return;
      }
      resolve(user);
    });
  });
}

async function callFunction(name, data = {}) {
  try {
    const fn = httpsCallable(functions, name);
    const result = await fn(data);
    if (result.data && result.data.success === false) {
      throw new Error(result.data.message || "فشلت العملية");
    }
    return result.data;
  } catch (e) {
    const message = e.message || "حدث خطأ غير متوقع";
    console.error(`[${name}]`, e.code || "", message);
    throw new Error(message);
  }
}

function ensureToastContainer() {
  let c = document.getElementById("toastContainer");
  if (!c) {
    c = document.createElement("div");
    c.id = "toastContainer";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function toast(message, type = "info", duration = 4000) {
  const c = ensureToastContainer();
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  const icons = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
  el.innerHTML = `<span>${icons[type] || "•"}</span><span>${escapeHTML(message)}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-20px)";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function withLoading(buttonEl, fn) {
  const originalText = buttonEl.innerHTML;
  buttonEl.disabled = true;
  buttonEl.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> جاري التنفيذ...`;
  return Promise.resolve(fn()).finally(() => {
    buttonEl.disabled = false;
    buttonEl.innerHTML = originalText;
  });
}

function escapeHTML(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function formatDate(d) {
  if (!d) return "—";
  let date;
  if (typeof d === "string") date = new Date(d);
  else if (d.seconds) date = new Date(d.seconds * 1000);
  else if (d instanceof Date) date = d;
  else return String(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleString("ar-EG", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

async function doLogin(email, password, rememberMe = true) {
  try {
    const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
    await setPersistence(auth, persistence);
    await signInWithEmailAndPassword(auth, email, password);
    return true;
  } catch (e) {
    const messages = {
      "auth/invalid-email": "بريد إلكتروني غير صالح",
      "auth/user-disabled": "هذا الحساب معطل",
      "auth/user-not-found": "لا يوجد حساب بهذا البريد.",
      "auth/wrong-password": "كلمة المرور خاطئة",
      "auth/invalid-credential": "البريد أو كلمة المرور غير صحيحة",
      "auth/too-many-requests": "محاولات كثيرة، حاول لاحقاً",
      "auth/network-request-failed": "خطأ في الاتصال بالإنترنت"
    };
    throw new Error(messages[e.code] || e.message);
  }
}

export {
  app, auth, functions,
  requireAuth, checkAdmin,
  callFunction,
  mountShell, buildHeader, buildSidebar,
  toast, withLoading,
  escapeHTML, formatDate,
  doLogin, signOut
};
