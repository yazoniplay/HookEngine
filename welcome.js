// Confetti burst from the centre, then the page is still. Runs as a file because MV3 blocks inline scripts.
const colors = ["#ff5b2e", "#0c0c0c"];
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (let i = 0; i < 26; i++) {
    const el = document.createElement("span");
    el.className = "bit";
    const angle = (Math.PI * 2 * i) / 26 + Math.random() * 0.3;
    const distance = 140 + Math.random() * 220;
    el.style.setProperty("--x", Math.cos(angle) * distance + "px");
    el.style.setProperty("--y", Math.sin(angle) * distance + "px");
    el.style.setProperty("--r", (Math.random() * 540 - 270) + "deg");
    el.style.background = colors[i % 2];
    el.style.animationDelay = (0.9 + Math.random() * 0.15) + "s";
    document.body.appendChild(el);
  }
}

document.getElementById("start").addEventListener("click", () => {
  if (globalThis.chrome?.tabs?.getCurrent) {
    chrome.tabs.getCurrent(tab => { if (tab?.id) chrome.tabs.remove(tab.id); else window.close(); });
  } else {
    window.close();
  }
});
