import { PLAN_CATALOG } from "../extension/plans.js";

const historyWindow = document.getElementById("freeHistoryWindow");
if (historyWindow) {
  historyWindow.textContent = PLAN_CATALOG.free.historyDays + " days";
}
