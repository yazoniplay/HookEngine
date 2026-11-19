// Confetti burst from the centre, then the page is still. Runs as a file because MV3 blocks inline scripts.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const colors = ["#ff5b2e", "#0c0c0c"];
if (!reduceMotion) {
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

// Sample drafts, fixed text. Nothing is generated or sent for this demo.
const drafts = [
  ["X thread", "1/ A planet’s atmosphere can leave clues in the light of its star."],
  ["LinkedIn", "A distant planet can leave a chemical fingerprint in starlight."],
  ["TikTok", "What if a planet’s air could be read from the colours missing in a beam of light?"]
];
const go = document.getElementById("go");
const out = document.getElementById("out");
const hi = document.getElementById("hi");
go.addEventListener("click", () => {
  go.disabled = true;
  go.textContent = "Making drafts…";
  hi.classList.add("on");
  document.getElementById("idle")?.remove();
  const delay = reduceMotion ? 0 : 500;
  drafts.forEach(([label, text], index) => {
    setTimeout(() => {
      const row = document.createElement("div");
      row.className = "out";
      row.innerHTML = '<div class="out-l"></div><div class="out-b"></div>';
      row.children[0].textContent = label;
      row.children[1].textContent = text;
      out.appendChild(row);
      requestAnimationFrame(() => row.classList.add("in"));
      if (index === drafts.length - 1) {
        go.textContent = "Done. Try it on a real page";
      }
    }, delay + index * 450);
  });
});

document.getElementById("start").addEventListener("click", () => {
  if (globalThis.chrome?.tabs?.getCurrent) {
    chrome.tabs.getCurrent(tab => { if (tab?.id) chrome.tabs.remove(tab.id); else window.close(); });
  } else {
    window.close();
  }
});
