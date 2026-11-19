// Light up the three platform marks in order, then burst a few squares from the brand mark.
// Runs as a file because MV3 blocks inline scripts. Reduced motion shows the final state.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const marks = [...document.querySelectorAll(".mark")];
if (reduceMotion) {
  marks.forEach(m => m.classList.add("on"));
} else {
  marks.forEach((m, i) => setTimeout(() => m.classList.add("on"), 1500 + i * 280));
  const origin = document.querySelector(".brand img").getBoundingClientRect();
  const x0 = origin.left + origin.width / 2, y0 = origin.top + origin.height / 2;
  for (let i = 0; i < 18; i++) {
    const el = document.createElement("span");
    el.className = "bit";
    const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.25;
    const distance = 120 + Math.random() * 160;
    el.style.left = x0 + "px";
    el.style.top = y0 + "px";
    el.style.background = i % 3 === 0 ? "#0c0c0c" : "#ff5b2e";
    el.style.setProperty("--x", Math.cos(angle) * distance + "px");
    el.style.setProperty("--y", Math.sin(angle) * distance + "px");
    el.style.setProperty("--r", (Math.random() * 540 - 270) + "deg");
    el.style.animationDelay = (0.9 + Math.random() * 0.1) + "s";
    document.body.appendChild(el);
  }
}

document.getElementById("close").addEventListener("click", () => {
  if (globalThis.chrome?.tabs?.getCurrent) {
    chrome.tabs.getCurrent(tab => { if (tab?.id) chrome.tabs.remove(tab.id); else window.close(); });
  } else {
    window.close();
  }
});
