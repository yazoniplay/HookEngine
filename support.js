// Single owner-configured support contact used by public pages.
export const SUPPORT_EMAIL = ""; // TODO(owner): Set a monitored support address before publishing.

for (const link of document.querySelectorAll("[data-support-email]")) {
  if (SUPPORT_EMAIL) {
    link.href = "mailto:" + SUPPORT_EMAIL;
    link.textContent = SUPPORT_EMAIL;
  } else {
    link.removeAttribute("href");
    link.textContent = "Support contact not configured";
    link.setAttribute("aria-disabled", "true");
  }
}
