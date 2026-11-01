import { SUPABASE_URL, SUPABASE_KEY } from "./extension/config.js";

const form = document.getElementById("waitlistForm");
const status = document.getElementById("waitlistStatus");

if (form && status) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const input = form.elements.email;
    const button = form.querySelector("button[type=submit]");
    const email = input.value.trim();
    button.disabled = true;
    status.textContent = "Submitting…";
    status.classList.remove("error");

    try {
      const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/hookengine_join_waitlist", {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_email: email })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (String(result.message || result.details || "").includes("waitlist_rate_limited")) {
          throw new Error("Too many attempts for this email. Try again after 24 hours.");
        }
        if (String(result.message || result.details || "").includes("invalid_email")) {
          throw new Error("Enter a valid email address.");
        }
        throw new Error("The waitlist could not be reached. Try again later.");
      }
      status.textContent = result.status === "already_joined"
        ? "That email is already on the list."
        : "You're on the list. We'll email you when Pro is available.";
      form.reset();
    } catch (error) {
      status.textContent = error.message || "The waitlist could not be reached. Try again later.";
      status.classList.add("error");
    } finally {
      button.disabled = false;
    }
  });
}
