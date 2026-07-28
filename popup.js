const WORKER_URL = "https://listinglens-api.bison-animol.workers.dev";
const STRIPE_URL = "https://buy.stripe.com/eVq00igG1apJ2Ks8zp3gk02";
const FREE_LIMIT = 5;
const SUPPORT_EMAIL = "listinglens.outreach@gmail.com";

async function verifySubscription(email) {
  try {
    const res = await fetch(`${WORKER_URL}/check-subscription`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    const active = !!data.active;
    await chrome.storage.local.set({ llProActive: active, llEmail: active ? email : "" });
    return active;
  } catch {
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const { llUsage = 0, llProActive = false } = await chrome.storage.local.get(["llUsage", "llProActive"]);

  const statusIcon = document.getElementById("status-icon");
  const statusText = document.getElementById("status-text");
  const statusSub = document.getElementById("status-sub");
  const proCard = document.getElementById("pro-card");
  const upgradeCard = document.getElementById("upgrade-card");
  const statUsed = document.getElementById("stat-used");
  const statRemaining = document.getElementById("stat-remaining");

  statUsed.textContent = llUsage;

  if (llProActive) {
    statusIcon.textContent = "⭐";
    statusText.textContent = "Pro — Active";
    statusSub.textContent = "Unlimited analyses unlocked";
    proCard.style.display = "flex";
    upgradeCard.style.display = "none";
    statRemaining.textContent = "∞";
    statRemaining.className = "stat-num pro";
    document.getElementById("cancel-sub-btn").style.display = "inline";
    document.getElementById("get-key-btn").style.display = "none";
  } else {
    const left = Math.max(0, FREE_LIMIT - llUsage);
    statusIcon.textContent = left > 0 ? "⚡" : "🔒";
    statusText.textContent = left > 0 ? `${left} free ${left === 1 ? "analysis" : "analyses"} left` : "Free limit reached";
    statusSub.textContent = "Open any Zillow or Realtor.com listing";
    proCard.style.display = "none";
    upgradeCard.style.display = "block";
    statRemaining.textContent = left;
    document.getElementById("cancel-sub-btn").style.display = "none";
  }

  // Start trial / upgrade → Stripe
  document.getElementById("upgrade-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: STRIPE_URL });
  });
  document.getElementById("get-key-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: STRIPE_URL });
  });

  // Activate by email
  document.getElementById("activate-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("email-input");
    const msg = document.getElementById("activate-msg");
    const btn = document.getElementById("activate-btn");
    const email = (input?.value || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      msg.textContent = "Please enter a valid email.";
      msg.className = "activate-msg err";
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    msg.textContent = "Checking your subscription…";
    msg.className = "activate-msg";
    const ok = await verifySubscription(email);
    btn.disabled = false;
    btn.textContent = "Activate";
    if (ok) {
      msg.textContent = "✓ Pro activated!";
      msg.className = "activate-msg ok";
      setTimeout(() => window.location.reload(), 800);
    } else {
      msg.textContent = "No active subscription found for this email.";
      msg.className = "activate-msg err";
    }
  });

  // Support
  document.getElementById("support-btn")?.addEventListener("click", () => {
    const box = document.getElementById("support-email-box");
    box.style.display = box.style.display === "none" ? "block" : "none";
  });

  // Deactivate (local only)
  document.getElementById("cancel-sub-btn")?.addEventListener("click", () => {
    const box = document.getElementById("cancel-confirm");
    box.style.display = box.style.display === "none" ? "block" : "none";
  });
  document.getElementById("cancel-yes")?.addEventListener("click", async () => {
    await chrome.storage.local.set({ llProActive: false, llEmail: "" });
    window.location.reload();
  });
  document.getElementById("cancel-no")?.addEventListener("click", () => {
    document.getElementById("cancel-confirm").style.display = "none";
  });
});

function copyEmail() {
  navigator.clipboard.writeText(SUPPORT_EMAIL).then(() => {
    const hint = document.getElementById("copy-hint");
    if (hint) {
      hint.textContent = "✓ Copied!";
      setTimeout(() => { hint.textContent = "Click to copy"; }, 2000);
    }
  });
}
