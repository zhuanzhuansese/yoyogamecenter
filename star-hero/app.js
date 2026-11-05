"use strict";

const STORAGE_KEY = "star-hero-v1";
const BONUS = 5; // extra stars for finishing every task in a day
const AVATARS = ["🦁", "🐼", "🐰", "🦊", "🐯", "🐨", "🐸", "🦄", "🐧", "🐶", "🐱", "🦖"];
const LEVELS = [
  [0, "星星新手"],
  [20, "小小努力家"],
  [50, "任务达人"],
  [100, "自律小明星"],
  [200, "闪耀勇士"],
  [400, "超级英雄"],
  [700, "星空大师"],
  [1000, "传奇之星"],
];

const DEFAULT_STATE = {
  name: "小勇士",
  avatar: "🦁",
  balance: 0,
  totalEarned: 0,
  redeemed: 0,
  tasks: [
    { id: "t1", icon: "🪥", name: "早上刷牙", points: 1 },
    { id: "t8", icon: "🪥", name: "午饭刷牙", points: 1 },
    { id: "t9", icon: "🪥", name: "晚上刷牙", points: 1 },
    { id: "t2", icon: "👕", name: "自己穿衣服", points: 2 },
    { id: "t3", icon: "📚", name: "阅读20分钟", points: 3 },
    { id: "t4", icon: "✏️", name: "完成作业", points: 3 },
    { id: "t5", icon: "🧸", name: "收拾玩具", points: 2 },
    { id: "t6", icon: "🥦", name: "好好吃饭不挑食", points: 2 },
    { id: "t7", icon: "🌙", name: "按时睡觉", points: 2 },
  ],
  rewards: [
    { id: "r1", icon: "🍦", name: "一个冰淇淋", cost: 15 },
    { id: "r2", icon: "📺", name: "看动画片30分钟", cost: 20 },
    { id: "r3", icon: "🎮", name: "玩游戏30分钟", cost: 25 },
    { id: "r4", icon: "🛝", name: "去公园玩", cost: 40 },
    { id: "r5", icon: "📖", name: "买一本新书", cost: 60 },
    { id: "r6", icon: "🧸", name: "挑一个小玩具", cost: 100 },
  ],
  // Task records are the source of truth for completions, streaks and the "today" checkmarks.
  records: [], // { id, taskId, name, icon, points, t, by: { username, role } }, newest first
  redemptions: [], // shop purchases: { id, rewardId, name, icon, cost, t, by }, newest first
  bonusDays: [],
  history: [], // other star changes: { t, icon, text, amount, by?, type?, date? }
};

const BADGES = [
  { icon: "👣", name: "第一步", desc: "完成第1个任务", test: (s) => s.totalEarned > 0 },
  { icon: "💯", name: "全勤一天", desc: "一天完成全部", test: (s) => s.bonusDays.length > 0 },
  { icon: "🔥", name: "坚持3天", desc: "连续3天打卡", test: (s) => bestStreak(s) >= 3 },
  { icon: "🌈", name: "坚持7天", desc: "连续7天打卡", test: (s) => bestStreak(s) >= 7 },
  { icon: "⭐", name: "50颗星", desc: "累计50颗星", test: (s) => s.totalEarned >= 50 },
  { icon: "🌟", name: "200颗星", desc: "累计200颗星", test: (s) => s.totalEarned >= 200 },
  { icon: "🎁", name: "第一份礼物", desc: "第1次兑换", test: (s) => s.redeemed >= 1 },
  { icon: "👑", name: "兑换达人", desc: "兑换10次", test: (s) => s.redeemed >= 10 },
];

let state = structuredClone(DEFAULT_STATE);
let me = null; // { username, role, family: { name } } of the logged-in family member
let members = [];
let parentUnlocked = false;
let lockAnswer = 0;

const $ = (sel) => document.querySelector(sel);

/* ---------------- storage (server) & dates ---------------- */

function withDefaults(saved) {
  const s = { ...structuredClone(DEFAULT_STATE), ...saved };
  if (s.days) {
    // Older data kept only task ids per day; turn those into records (submitter unknown).
    for (const [date, ids] of Object.entries(s.days)) {
      const [y, m, d] = date.split("-").map(Number);
      for (const taskId of ids) {
        const task = s.tasks.find((t) => t.id === taskId) || { name: "已删除的任务", icon: "❔", points: 0 };
        s.records.push({ id: newId("rec"), taskId, name: task.name, icon: task.icon, points: task.points, t: new Date(y, m - 1, d, 12).getTime(), by: null });
      }
    }
    s.records.sort((a, b) => b.t - a.t);
    delete s.days;
  }
  // Older data kept purchases only as history lines ("兑换：…"); turn those into redemption records.
  const bought = s.history.filter((h) => h.amount < 0 && h.text?.startsWith("兑换："));
  if (bought.length) {
    for (const h of bought) {
      const name = h.text.slice(3);
      const rewardId = s.rewards.find((r) => r.name === name)?.id ?? null;
      s.redemptions.push({ id: newId("buy"), rewardId, name, icon: h.icon, cost: -h.amount, t: h.t, by: h.by ?? null });
    }
    s.redemptions.sort((a, b) => b.t - a.t);
    s.history = s.history.filter((h) => !bought.includes(h));
  }
  return s;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// fetch for data endpoints: a 401 means the session ended, so go back to the login screen.
async function api(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", ...options });
  if (res.status === 401) {
    showAuth("登录已过期，请重新登录");
    throw new Error("请先登录");
  }
  return res;
}

async function load() {
  const res = await api("/api/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) {
    // Nothing on the server yet: carry over data from the earlier browser-only version once.
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (local) {
      state = withDefaults(local);
      await putState();
      localStorage.removeItem(STORAGE_KEY);
    }
    return;
  }
  state = withDefaults(await res.json());
}

// Saves are debounced and sent one at a time, so the server always ends with the latest state.
let saveTimer = null;
let saveChain = Promise.resolve();
let savesInFlight = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  savesInFlight++;
  saveChain = saveChain
    .then(putState)
    .catch(() => toast("⚠️ 保存到服务器失败，请检查网络"))
    .finally(() => savesInFlight--);
  return saveChain;
}

async function putState() {
  const res = await api("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (res.status === 409) {
    // Another family member saved first: take their version rather than overwrite it.
    state = withDefaults(await res.json());
    render();
    toast("家人刚刚更新了数据，已同步，请再操作一次");
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.rev = (await res.json()).rev;
}

// Pick up changes other family members made, unless this device has unsaved changes of its own.
async function refresh() {
  if (!me || saveTimer || savesInFlight || document.hidden) return;
  try {
    const res = await api("/api/state");
    if (res.status !== 200 || saveTimer || savesInFlight) return;
    const latest = await res.json();
    if (latest.rev === state.rev) return;
    state = withDefaults(latest);
    render();
  } catch {}
}
document.addEventListener("visibilitychange", refresh);

addEventListener("pagehide", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    navigator.sendBeacon("/api/state", new Blob([JSON.stringify(state)], { type: "application/json" }));
  }
});

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  return dateKey(new Date(y, m - 1, d + delta));
}

const recordDate = (rec) => dateKey(new Date(rec.t));

function doneOn(date) {
  return state.records.filter((r) => recordDate(r) === date).map((r) => r.taskId);
}

function doneToday() {
  return doneOn(dateKey());
}

function activeDays(s) {
  return new Set(s.records.map(recordDate));
}

function currentStreak(s) {
  const days = activeDays(s);
  let key = dateKey();
  if (!days.has(key)) key = shiftDay(key, -1); // today not started yet: keep yesterday's streak alive
  let n = 0;
  while (days.has(key)) {
    n++;
    key = shiftDay(key, -1);
  }
  return n;
}

function bestStreak(s) {
  const days = activeDays(s);
  let best = 0;
  for (const key of days) {
    if (days.has(shiftDay(key, -1))) continue; // only count from the start of a run
    let n = 0;
    let k = key;
    while (days.has(k)) {
      n++;
      k = shiftDay(k, 1);
    }
    best = Math.max(best, n);
  }
  return best;
}

function levelInfo(total) {
  let i = 0;
  while (i + 1 < LEVELS.length && total >= LEVELS[i + 1][0]) i++;
  const [start, name] = LEVELS[i];
  const next = LEVELS[i + 1];
  const pct = next ? ((total - start) / (next[0] - start)) * 100 : 100;
  return { label: `Lv.${i + 1} ${name}`, pct, toNext: next ? next[0] - total : 0 };
}

/* ---------------- state changes ---------------- */

function addStars(amount, icon, text, extra = {}) {
  state.balance += amount;
  if (amount > 0) state.totalEarned += amount;
  state.history.unshift({ t: Date.now(), icon, text, amount, by: byMe(), ...extra });
  state.history = state.history.slice(0, 200);
}

const byMe = () => (me ? { username: me.username, role: me.role } : null);

// Changing a record's stars also changes the balance and the lifetime total.
function changeEarned(delta) {
  state.balance += delta;
  state.totalEarned += delta;
}

// If a day lost a task record after its full-attendance bonus was granted, take the bonus back.
function revokeBonusIfIncomplete(date) {
  if (!state.bonusDays.includes(date)) return;
  const done = doneOn(date);
  if (state.tasks.every((t) => done.includes(t.id))) return;
  state.bonusDays = state.bonusDays.filter((d) => d !== date);
  changeEarned(-BONUS);
  const i = state.history.findIndex((h) => h.type === "bonus" && h.date === date);
  if (i >= 0) state.history.splice(i, 1);
}

function deleteRecord(rec) {
  rec = state.records.find((r) => r.id === rec.id); // the state may have been refreshed since rec was read
  if (!rec) return;
  state.records = state.records.filter((r) => r.id !== rec.id);
  changeEarned(-rec.points);
  revokeBonusIfIncomplete(recordDate(rec));
}

function updateRecord(rec, { t, points }) {
  const oldDate = recordDate(rec);
  changeEarned(points - rec.points);
  Object.assign(rec, { t, points });
  state.records.sort((a, b) => b.t - a.t);
  if (recordDate(rec) !== oldDate) revokeBonusIfIncomplete(oldDate);
}

// Undo the most recent completion of this task today (records are newest first).
function undoTask(task) {
  const today = dateKey();
  const latest = state.records.find((r) => r.taskId === task.id && recordDate(r) === today);
  if (!latest) return;
  confirmModal("🤔", `撤销一次「${task.name}」？`, `这次的 ${latest.points} 颗星会被收回，这条任务记录也会删除`, "撤销", () => {
    deleteRecord(latest);
    save();
    render();
  });
}

// Tapping a task: the kid first adds the task's stars to the wallet, and only a right answer counts it.
async function startTask(task) {
  const ok = await mathQuiz({
    item: task,
    title: task.name,
    a: state.balance,
    b: task.points,
    op: "+",
    labels: ["现在有", "完成任务", "一共有"],
    tip: "算一算，现在一共有几颗星星？",
  });
  if (ok) completeTask(task);
}

// A task can be completed any number of times; each completion is its own record.
function completeTask(task) {
  const today = dateKey();
  const badgesBefore = earnedBadges();
  state.records.unshift({ id: newId("rec"), taskId: task.id, name: task.name, icon: task.icon, points: task.points, t: Date.now(), by: byMe() });
  changeEarned(task.points);
  celebrate(task);

  const done = doneOn(today);
  const allDone = state.tasks.length > 0 && state.tasks.every((t) => done.includes(t.id));
  if (allDone && !state.bonusDays.includes(today)) {
    state.bonusDays.push(today);
    addStars(BONUS, "💯", "全勤奖励", { type: "bonus", date: today });
    // After the task's own animation: a full fireworks show, then the congratulations dialog.
    setTimeout(() => {
      fireworks(6, { spread: 400 });
      confetti();
      playSound("win");
    }, 2500);
    setTimeout(() => infoModal("🎉", "太棒啦！今天全部完成！", `额外奖励 ${BONUS} 颗星星，你是最棒的！`), 4900);
  }

  save();
  render();
  announceNewBadges(badgesBefore, allDone ? 5200 : 2600);
}

// Tapping a reward: it drops into the shopping cart, then at the checkout the kid works out
// the stars left (before − price = after); a right answer completes the purchase.
let shopping = false;
async function redeem(reward, el) {
  if (shopping) return;
  if (state.balance < reward.cost) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    playSound("nope");
    toast(`还差 ${reward.cost - state.balance} 颗星星，继续加油！💪`);
    return;
  }
  shopping = true;
  const cart = await dropIntoCart(el.querySelector(".goods-icon"), reward);
  cart.classList.add("leave"); // the checkout card shows the reward in the cart from here on
  setTimeout(() => cart.remove(), 500);
  const ok = await mathQuiz({
    item: reward,
    title: reward.name,
    a: state.balance,
    b: reward.cost,
    op: "−",
    labels: ["兑换前", "价格", "兑换后"],
    tip: "算一算，兑换后还剩几颗星星？",
    checkout: true,
  });
  shopping = false;
  if (!ok) return toast("商品放回货架啦，下次再来～");
  if (state.balance < reward.cost) return toast("星星不够啦，家人可能刚刚用掉了一些"); // a family member's change arrived meanwhile

  const badgesBefore = earnedBadges();
  state.redemptions.unshift({ id: newId("buy"), rewardId: reward.id, name: reward.name, icon: reward.icon, cost: reward.cost, t: Date.now(), by: byMe() });
  state.balance -= reward.cost;
  state.redeemed += 1;
  save();
  render();
  confetti();
  playSound("win");
  infoModal(reward.icon, "兑换成功！", `快去找爸爸妈妈领取「${reward.name}」吧！`);
  announceNewBadges(badgesBefore, 2500);
}

function deleteRedemption(buy) {
  buy = state.redemptions.find((b) => b.id === buy.id); // the state may have been refreshed since buy was read
  if (!buy) return;
  state.redemptions = state.redemptions.filter((b) => b.id !== buy.id);
  state.balance += buy.cost;
  state.redeemed = Math.max(0, state.redeemed - 1);
}

function updateRedemption(buy, { t, cost }) {
  state.balance -= cost - buy.cost;
  Object.assign(buy, { t, cost });
  state.redemptions.sort((a, b) => b.t - a.t);
}

// Undo the most recent purchase of this reward today; its stars go back into the wallet.
function undoReward(reward) {
  const today = dateKey();
  const latest = state.redemptions.find((b) => b.rewardId === reward.id && recordDate(b) === today);
  if (!latest) return;
  confirmModal("🤔", `撤销一次「${reward.name}」？`, `${latest.cost} 颗星星会退回，这条兑换记录也会删除`, "撤销", () => {
    deleteRedemption(latest);
    save();
    render();
    toast(`已退回 ${latest.cost} 颗星星`);
  });
}

// The reward's picture falls from the shelf into a shopping cart that rolls in at the bottom.
function dropIntoCart(iconEl, reward) {
  const cart = document.createElement("div");
  cart.className = "cart";
  cart.textContent = "🛒";
  document.body.append(cart);
  const from = iconEl.getBoundingClientRect();
  const item = document.createElement("div");
  item.className = "cart-drop";
  setVisual(item, reward);
  item.style.left = `${from.left + from.width / 2}px`;
  item.style.top = `${from.top + from.height / 2}px`;
  document.body.append(item);
  return new Promise((resolve) => {
    setTimeout(() => {
      const to = cart.getBoundingClientRect();
      const dx = to.left + to.width * 0.55 - (from.left + from.width / 2);
      const dy = to.top + to.height * 0.3 - (from.top + from.height / 2);
      playSound("drop");
      // A little hop up first, then a fall with gravity, spinning into the basket.
      item.animate(
        [
          { transform: "translate(-50%, -50%) scale(1) rotate(0deg)" },
          { transform: `translate(calc(-50% + ${dx * 0.25}px), calc(-50% - 50px)) scale(1.15) rotate(-20deg)`, offset: 0.25, easing: "ease-in" },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.6) rotate(200deg)` },
        ],
        { duration: 900, easing: "ease-out", fill: "forwards" },
      ).finished.then(() => {
        item.remove();
        cart.classList.add("bump");
        setTimeout(() => resolve(cart), 450);
      });
    }, 350); // let the cart roll in first
  });
}

// A big, kid-friendly arithmetic card with three answer buttons. Resolves true after the right
// answer is tapped (wrong ones shake and can be retried), false if it is closed with ✕.
function mathQuiz({ item, title, a, b, op, labels, tip, checkout = false }) {
  const answer = op === "+" ? a + b : a - b;
  const wrong = [answer + 1, answer - 1, answer + 2, answer - 2, a].filter((n) => n !== answer && n >= Math.min(0, answer));
  const choices = shuffle([answer, ...shuffle([...new Set(wrong)]).slice(0, 2)]);

  const box = $("#mathQuiz");
  box.classList.toggle("checkout", checkout);
  $("#quizHead").textContent = checkout ? "🛒 结算台" : "⭐ 算一算";
  setVisual($("#quizIcon"), item);
  $("#quizTitle").textContent = title;
  const cols = box.querySelectorAll(".eq-col");
  [a, b, "?"].forEach((v, i) => {
    cols[i].querySelector("small").textContent = labels[i];
    cols[i].querySelector("b").textContent = v;
  });
  cols[2].classList.remove("solved");
  $("#quizOp").textContent = op;
  $("#quizTip").textContent = tip;
  $("#quizTip").classList.remove("oops");
  const btns = $("#quizChoices");
  btns.innerHTML = "";
  box.classList.remove("hidden");

  return new Promise((resolve) => {
    const finish = (ok) => {
      box.classList.add("hidden");
      $("#quizClose").onclick = null;
      resolve(ok);
    };
    $("#quizClose").onclick = () => finish(false);
    for (const n of choices) {
      const btn = document.createElement("button");
      btn.className = "quiz-choice";
      btn.textContent = n;
      btn.addEventListener("click", () => {
        if (n !== answer) {
          btn.classList.add("wrong");
          btn.disabled = true;
          playSound("nope");
          $("#quizTip").textContent = "再想想哦～ 🤔";
          $("#quizTip").classList.add("oops");
          return;
        }
        btns.querySelectorAll("button").forEach((x) => (x.disabled = true));
        btn.classList.add("right");
        cols[2].querySelector("b").textContent = answer;
        cols[2].classList.add("solved");
        $("#quizTip").textContent = "答对啦！🎉";
        $("#quizTip").classList.remove("oops");
        playSound("ding");
        setTimeout(() => finish(true), 800);
      });
      btns.append(btn);
    }
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function earnedBadges() {
  return BADGES.filter((b) => b.test(state)).map((b) => b.name);
}

function announceNewBadges(before, delay) {
  const fresh = BADGES.filter((b) => b.test(state) && !before.includes(b.name));
  if (!fresh.length) return;
  setTimeout(() => {
    const b = fresh[0];
    confetti();
    infoModal(b.icon, `获得新徽章：${b.name}`, b.desc);
  }, delay);
}

/* ---------------- rendering ---------------- */

function render() {
  const done = doneToday();
  const lv = levelInfo(state.totalEarned);

  $("#kidName").textContent = state.name;
  $("#avatarBtn").textContent = state.avatar;
  $("#levelName").textContent = lv.label;
  $("#levelFill").style.width = `${lv.pct}%`;
  setBalance(state.balance);
  $("#streak").textContent = currentStreak(state);
  $("#totalEarned").textContent = state.totalEarned;

  const doneCount = state.tasks.filter((t) => done.includes(t.id)).length;
  $("#todayDone").textContent = `${doneCount}/${state.tasks.length}`;
  $("#today").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const pct = state.tasks.length ? (doneCount / state.tasks.length) * 100 : 0;
  $("#progressFill").style.width = `${pct}%`;
  const left = state.tasks.length - doneCount;
  $("#progressTip").textContent = !state.tasks.length
    ? ""
    : left === 0
      ? "🎉 今天的任务全部完成啦！"
      : `再完成 ${left} 个任务，就能拿到全勤奖励 +${BONUS}⭐`;

  renderTasks(done);
  renderRewards();
  renderBadges();
  renderHistory();
  if (parentUnlocked) renderParent();
}

let shownBalance = null;
function setBalance(n) {
  const el = $("#balance");
  if (shownBalance !== null && n !== shownBalance) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }
  shownBalance = n;
  el.textContent = n;
}

// Collapsed task groups, remembered on this device.
const COLLAPSE_KEY = "star-hero-collapsed";
const collapsedGroups = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));

function renderTasks(done) {
  const count = (id) => done.filter((d) => d === id).length;
  const ul = $("#taskList");
  ul.innerHTML = "";
  if (!state.tasks.length) {
    ul.innerHTML = `<li class="empty">还没有任务哦，请爸爸妈妈在「家长」里添加～</li>`;
    return;
  }
  for (const group of TASK_GROUPS) {
    const tasks = state.tasks.filter((t) => groupOf(t) === group.key);
    if (!tasks.length) continue;
    const doneN = tasks.filter((t) => count(t.id)).length;
    const closed = collapsedGroups.has(group.key);
    const head = document.createElement("li");
    head.className = "task-group" + (doneN === tasks.length ? " all-done" : "");
    head.innerHTML = `
      <button class="task-group-btn" aria-expanded="${!closed}">
        <span class="tg-name"></span><span class="tg-count">${doneN}/${tasks.length}</span><span class="tg-arrow">${closed ? "▸" : "▾"}</span>
      </button>`;
    head.querySelector(".tg-name").textContent = group.label;
    head.querySelector("button").addEventListener("click", () => {
      if (closed) collapsedGroups.delete(group.key);
      else collapsedGroups.add(group.key);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedGroups]));
      renderTasks(doneToday());
    });
    ul.append(head);
    if (!closed) for (const task of tasks) ul.append(taskItem(task, count(task.id)));
  }
}

function taskItem(task, n) {
  const li = document.createElement("li");
  li.className = "task-item";
  const btn = document.createElement("button");
  btn.className = "task" + (n ? " done" : "");
  btn.innerHTML = `
    <span class="task-icon"></span>
    <span class="task-name"></span>
    <span class="task-pts">+${task.points} ⭐</span>
    <span class="task-check">${n > 1 ? `×${n}` : "✓"}</span>`;
  setVisual(btn.querySelector(".task-icon"), task);
  btn.querySelector(".task-name").textContent = task.name;
  btn.addEventListener("click", () => startTask(task));
  li.append(btn);
  if (n) {
    const undo = document.createElement("button");
    undo.className = "task-undo";
    undo.textContent = "撤销";
    undo.title = "撤销最近一次";
    undo.addEventListener("click", () => undoTask(task));
    li.append(undo);
  }
  return li;
}

// Rewards sit on wooden shelves, three per shelf, each with a hanging price tag.
const PER_SHELF = 3;
function renderRewards() {
  $("#shopBalance").textContent = state.balance;
  const cabinet = $("#rewardList");
  cabinet.innerHTML = "";
  if (!state.rewards.length) {
    cabinet.innerHTML = `<p class="empty shelf-empty">货架还空着，请爸爸妈妈在「家长」里添加奖品～</p>`;
    return;
  }
  const today = dateKey();
  const boughtToday = (id) => state.redemptions.filter((b) => b.rewardId === id && recordDate(b) === today).length;
  for (let i = 0; i < state.rewards.length; i += PER_SHELF) {
    const shelf = document.createElement("div");
    shelf.className = "shelf";
    for (const r of state.rewards.slice(i, i + PER_SHELF)) {
      const can = state.balance >= r.cost;
      const n = boughtToday(r.id);
      const slot = document.createElement("div");
      slot.className = "goods-slot";
      const goods = document.createElement("button");
      goods.className = "goods" + (can ? " can" : "");
      goods.innerHTML = `
        <span class="goods-icon"></span>
        <span class="price-tag">
          <span class="tag-name"></span>
          <span class="tag-price">${r.cost}<small>⭐</small></span>
          <span class="tag-note">${can ? "可兑换" : `还差 ${r.cost - Math.max(0, state.balance)}⭐`}</span>
        </span>`;
      setVisual(goods.querySelector(".goods-icon"), r);
      goods.querySelector(".tag-name").textContent = r.name;
      goods.addEventListener("click", () => redeem(r, goods));
      slot.append(goods);
      if (n) {
        // Bought today: how many times, and undo the latest one (like tasks).
        const count = document.createElement("span");
        count.className = "goods-count";
        count.textContent = `×${n}`;
        count.title = `今天兑换了 ${n} 次`;
        const undo = document.createElement("button");
        undo.className = "goods-undo";
        undo.textContent = "撤销";
        undo.title = "撤销最近一次兑换";
        undo.addEventListener("click", () => undoReward(r));
        slot.append(count, undo);
      }
      shelf.append(slot);
    }
    cabinet.append(shelf);
  }
}

function renderBadges() {
  $("#badgeList").innerHTML = BADGES.map(
    (b) => `<li class="badge ${b.test(state) ? "" : "off"}"><span>${b.icon}</span>${b.name}<small>${b.desc}</small></li>`,
  ).join("");
}

// Shows a task's uploaded image, or its emoji when it has none.
function setVisual(el, item) {
  el.textContent = "";
  if (item.image) {
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = "";
    el.append(img);
  } else {
    el.textContent = item.icon || "⭐";
  }
}

// Records keep the task's (or reward's) name/emoji from when they were submitted; images come from
// the current task or reward.
const isPurchase = (rec) => "rewardId" in rec;
const recordVisual = (rec) => ({
  icon: rec.icon,
  image: isPurchase(rec) ? state.rewards.find((r) => r.id === rec.rewardId)?.image : state.tasks.find((t) => t.id === rec.taskId)?.image,
});
// Task records and purchases together, newest first, as { rec, text, amount } rows.
const recordRows = () =>
  [
    ...state.records.map((rec) => ({ rec, text: rec.name, amount: rec.points })),
    ...state.redemptions.map((rec) => ({ rec, text: `兑换：${rec.name}`, amount: -rec.cost })),
  ].sort((a, b) => b.rec.t - a.rec.t);
const byText = (by) => (by ? `${by.role} ${by.username}` : "");
const timeText = (t, opts) => new Date(t).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", ...opts });

function renderHistory() {
  const ul = $("#historyList");
  ul.innerHTML = "";
  const entries = [
    ...recordRows().map(({ rec, text, amount }) => ({ ...recordVisual(rec), t: rec.t, text, amount, by: rec.by })),
    ...state.history,
  ].sort((a, b) => b.t - a.t);
  if (!entries.length) {
    ul.innerHTML = `<li class="empty">完成任务后，星星记录会出现在这里</li>`;
    return;
  }
  for (const h of entries.slice(0, 50)) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="h-icon"></span>
      <span class="h-text"><span></span><small></small></span>
      <span class="h-amt ${h.amount >= 0 ? "plus" : "minus"}">${h.amount >= 0 ? "+" : ""}${h.amount}⭐</span>`;
    setVisual(li.querySelector(".h-icon"), h);
    li.querySelector(".h-text span").textContent = h.text;
    li.querySelector(".h-text small").textContent = [timeText(h.t, { month: "numeric", day: "numeric" }), byText(h.by)].filter(Boolean).join(" · ");
    ul.append(li);
  }
}

/* ---------------- parent area ---------------- */

function newLockQuestion() {
  const a = 11 + Math.floor(Math.random() * 15);
  const b = 3 + Math.floor(Math.random() * 7);
  lockAnswer = a * b;
  $("#lockQuestion").textContent = `${a} × ${b} = ?`;
  $("#lockAnswer").value = "";
}

function renderParent() {
  $("#parentLock").classList.toggle("hidden", parentUnlocked);
  $("#parentArea").classList.toggle("hidden", !parentUnlocked);
  if (!parentUnlocked) return;

  $("#accountName").textContent = `${me.username}（${me.role}）`;
  const nameInput = $("#nameInput");
  if (document.activeElement !== nameInput) nameInput.value = state.name;

  $("#avatarPick").innerHTML = "";
  for (const a of AVATARS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a;
    b.className = a === state.avatar ? "sel" : "";
    b.addEventListener("click", () => {
      state.avatar = a;
      save();
      render();
    });
    $("#avatarPick").append(b);
  }

  renderEditList($("#editTasks"), state.tasks, "points", "颗星", (t) => openItemEditor("task", t));
  renderEditList($("#editRewards"), state.rewards, "cost", "颗星", (r) => openItemEditor("reward", r));
  renderSuggestions("task", $("#suggestTasks"));
  renderSuggestions("reward", $("#suggestRewards"));
  renderRecords();
}

let recordLimit = 20;
function renderRecords() {
  const ul = $("#recordList");
  ul.innerHTML = "";
  const rows = recordRows();
  if (!rows.length) ul.innerHTML = `<li class="empty">还没有记录</li>`;
  let lastDay = "";
  for (const { rec, text, amount } of rows.slice(0, recordLimit)) {
    const buy = isPurchase(rec);
    const day = recordDate(rec);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("li");
      h.className = "rec-day";
      h.textContent = new Date(rec.t).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
      ul.append(h);
    }
    const li = document.createElement("li");
    li.className = "rec" + (buy ? " buy" : "");
    li.innerHTML = `
      <span class="e-icon"></span>
      <span class="e-name"><span></span><small></small></span>
      <span class="e-pts">${amount > 0 ? "+" : ""}${amount}⭐</span>
      <button class="btn small" data-act="edit">修改</button>
      <button class="btn small danger" data-act="del">删除</button>`;
    setVisual(li.querySelector(".e-icon"), recordVisual(rec));
    li.querySelector(".e-name span").textContent = text;
    li.querySelector(".e-name small").textContent = `${timeText(rec.t)} · ${byText(rec.by) || "提交人未知"}`;
    li.querySelector('[data-act="edit"]').addEventListener("click", () => openRecordEditor(rec));
    li.querySelector('[data-act="del"]').addEventListener("click", () =>
      buy
        ? confirmModal("🗑️", "删除这条兑换记录？", `「${rec.name}」花掉的 ${rec.cost} 颗星会退回`, "删除", () => {
            deleteRedemption(rec);
            save();
            render();
            toast("记录已删除，星星已退回");
          })
        : confirmModal("🗑️", "删除这条任务记录？", `「${rec.name}」的 ${rec.points} 颗星会被收回`, "删除", () => {
            deleteRecord(rec);
            save();
            render();
            toast("记录已删除，星星已退回");
          }),
    );
    ul.append(li);
  }
  $("#moreRecords").classList.toggle("hidden", rows.length <= recordLimit);
}

function renderEditList(ul, items, numKey, unit, onEdit) {
  ul.innerHTML = "";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="e-icon"></span>
      <span class="e-name"></span>
      <span class="e-pts">${item[numKey]} ${unit}</span>
      <button class="btn small" data-act="up" title="上移">↑</button>
      ${onEdit ? `<button class="btn small" data-act="edit">编辑</button>` : ""}
      <button class="btn small danger" data-act="del">删除</button>`;
    setVisual(li.querySelector(".e-icon"), item);
    if (onEdit) li.querySelector('[data-act="edit"]').addEventListener("click", () => onEdit(item));
    li.querySelector(".e-name").textContent = item.name;
    li.querySelector('[data-act="up"]').disabled = i === 0;
    li.querySelector('[data-act="up"]').addEventListener("click", () => {
      [items[i - 1], items[i]] = [items[i], items[i - 1]];
      save();
      render();
    });
    li.querySelector('[data-act="del"]').addEventListener("click", () => {
      confirmModal("🗑️", `删除「${item.name}」？`, "删除后不能恢复", "删除", () => {
        items.splice(i, 1);
        save();
        render();
      });
    });
    ul.append(li);
  });
}

function bindParent() {
  newLockQuestion();
  $("#lockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (Number($("#lockAnswer").value) === lockAnswer) {
      parentUnlocked = true;
      render();
      loadMembers();
    } else {
      toast("答案不对哦，再试一次");
      $("#parentLock").classList.remove("shake");
      void $("#parentLock").offsetWidth;
      $("#parentLock").classList.add("shake");
      newLockQuestion();
    }
  });

  $("#nameInput").addEventListener("input", (e) => {
    state.name = e.target.value.trim() || "小勇士";
    save();
    $("#kidName").textContent = state.name;
  });

  $("#addTaskBtn").addEventListener("click", () => openItemEditor("task"));
  $("#addRewardBtn").addEventListener("click", () => openItemEditor("reward"));
  $("#moreRecords").addEventListener("click", () => {
    recordLimit += 20;
    renderRecords();
  });
  bindEditors();

  $("#adjustForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = Math.trunc(Number(f.amount.value));
    if (!amount) return;
    addStars(amount, amount > 0 ? "💝" : "📝", f.reason.value.trim() || `${me.role}${amount > 0 ? "的奖励" : "调整"}`);
    f.reset();
    save();
    render();
    if (amount > 0) playSound("ding");
    toast(`已${amount > 0 ? "奖励" : "扣除"} ${Math.abs(amount)} 颗星`);
  });

  $("#lockBtn").addEventListener("click", () => {
    parentUnlocked = false;
    newLockQuestion();
    renderParent();
  });

  $("#exportBtn").addEventListener("click", async () => {
    await flushSave(); // make sure the download includes the very latest changes
    location.href = "/api/export";
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    confirmModal("📤", "上传并覆盖数据？", `用「${file.name}」替换服务器上现在的数据`, "上传", async () => {
      try {
        clearTimeout(saveTimer);
        saveTimer = null;
        await saveChain;
        const res = await api("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        state = withDefaults(body);
        render();
        toast("数据已上传 ✅");
      } catch (err) {
        infoModal("😥", "上传失败", err.message || "请检查文件后再试");
      }
    });
  });

  $("#resetBtn").addEventListener("click", () => {
    confirmModal("⚠️", "清空所有数据？", "星星、记录、任务和奖励都会恢复到初始状态", "清空", () => {
      state = { ...structuredClone(DEFAULT_STATE), rev: state.rev }; // keep rev so the save is not seen as a conflict
      save();
      render();
      toast("已恢复初始状态");
    });
  });
}

function clampInt(v, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(v)) || min));
}

/* ---------------- task / reward & record editors ---------------- */

// Tasks and rewards share one editor; they differ in the list, the number field and defaults.
const EDIT_KINDS = {
  task: { list: () => state.tasks, numKey: "points", max: 99, numLabel: "星星", word: "任务", icon: "🌟", num: 2, prefix: "t" },
  reward: { list: () => state.rewards, numKey: "cost", max: 999, numLabel: "价格", word: "奖品", icon: "🎁", num: 20, prefix: "r" },
};
// Ideas for a 5-year-old in kindergarten, listed under the task and reward lists. Tapping one opens
// the editor filled in so parents can adjust it before adding; ones already in the list are hidden.
// [icon, name, stars or price, optional animation when the name alone would pick the wrong one]
const SUGGESTIONS = {
  task: [
    ["生活自理", [["🧦", "自己穿袜子", 1], ["👟", "自己穿鞋", 1], ["🧼", "自己洗脸", 1], ["💇", "自己梳头", 1], ["🎒", "整理书包", 2, "tidy"], ["👚", "叠衣服", 2], ["🛁", "自己洗澡", 2]]],
    ["家务小帮手", [["🥢", "帮忙摆碗筷", 1], ["🧽", "擦桌子", 1], ["🗑️", "倒垃圾", 1], ["🪴", "给花浇水", 1]]],
    ["学习兴趣", [["🔤", "认字10个", 2], ["🔢", "数数到100", 2], ["📜", "背一首古诗", 3], ["🔠", "学3个英语单词", 2], ["🎨", "画一幅画", 2], ["🎵", "唱一首儿歌", 1], ["🎶", "弹古筝", 3], ["⚫️", "下围棋", 3], ["🎲", "玩桌游", 2]]],
    ["运动", [["🏀", "拍球20下", 2], ["🏃", "跑步10分钟", 2], ["🛴", "骑滑板车", 2], ["🤸", "做早操", 1]]],
    ["好习惯", [["😴", "午睡", 2], ["🍎", "吃一份水果", 1], ["🥛", "喝牛奶", 1], ["🥦", "吃饭不挑食", 2], ["🙏", "说请和谢谢", 1], ["👋", "主动打招呼", 1], ["🤝", "和小朋友分享", 2]]],
  ],
  reward: [
    ["好吃的", [["🍬", "一颗糖果", 3], ["🍮", "一个果冻", 3], ["🥛", "一盒酸奶", 5], ["🎂", "一块小蛋糕", 10], ["🍟", "吃一次麦当劳", 30]]],
    ["小特权", [["📖", "多讲一个故事", 5], ["🛁", "泡泡浴", 8], ["🌙", "晚睡15分钟", 10], ["🍽️", "选今天的晚餐", 10], ["🎲", "和爸爸妈妈玩桌游", 10], ["👑", "当一天小主人", 50]]],
    ["出去玩", [["🫧", "吹泡泡", 8], ["🪁", "放风筝", 15], ["📚", "去图书馆", 15], ["🎠", "去游乐场", 30], ["🎬", "看一场电影", 40], ["🦁", "去动物园", 60], ["🐬", "去海洋馆", 80]]],
    ["小礼物", [["⭐", "一张贴纸", 2], ["🎈", "一个气球", 5], ["🖍️", "一盒新蜡笔", 20], ["🎁", "一个盲盒", 30], ["🧱", "一盒积木", 50]]],
  ],
};

function renderSuggestions(kind, box) {
  const k = EDIT_KINDS[kind];
  const have = new Set(k.list().map((x) => x.name));
  box.innerHTML = "";
  for (const [group, items] of SUGGESTIONS[kind]) {
    const left = items.filter(([, name]) => !have.has(name));
    if (!left.length) continue;
    const title = document.createElement("div");
    title.className = "suggest-group";
    title.textContent = group;
    const row = document.createElement("div");
    row.className = "suggest-row";
    for (const [icon, name, num, anim] of left) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "suggest-chip";
      chip.textContent = `＋ ${icon} ${name} · ${num}⭐`;
      chip.addEventListener("click", () => openItemEditor(kind, { icon, name, [k.numKey]: num, anim }));
      row.append(chip);
    }
    box.append(title, row);
  }
  if (!box.children.length) box.innerHTML = `<p class="hint">推荐的都已经添加啦 🎉</p>`;
}

let editKind = "task";
let editingItemId = null; // null while adding a new item
let editImage = null;
let editingRecordId = null;

function openEditor(sel) {
  $(sel).classList.remove("hidden");
}

function closeEditors() {
  document.querySelectorAll("#itemEditor, #recordEditor, #passwordEditor").forEach((m) => m.classList.add("hidden"));
}

function openItemEditor(kind, item = null) {
  const k = EDIT_KINDS[kind];
  const f = $("#itemEditForm");
  editKind = kind;
  editingItemId = item?.id ?? null;
  editImage = item?.image || null;
  f.icon.value = item?.icon || k.icon;
  f.name.value = item?.name || "";
  f.num.value = item?.[k.numKey] ?? k.num;
  f.num.max = k.max;
  $("#itemNumLabel").textContent = k.numLabel;
  f.querySelectorAll(".task-only").forEach((el) => el.classList.toggle("hidden", kind !== "task"));
  updateAnimOptions(); // build the options before choosing among them
  f.anim.value = item?.anim || "";
  f.group.value = item?.group || "";
  updateAnimOptions(); // the "auto" group follows the chosen animation
  $("#itemEditTitle").textContent = `${editingItemId ? "编辑" : "添加"}${k.word}`; // suggestions arrive as unsaved items
  updateItemPreview();
  openEditor("#itemEditor");
}

// The "auto" options name the animation the current task name would get, and the group that
// animation (or the chosen one) puts the task in.
function updateAnimOptions() {
  const f = $("#itemEditForm");
  const chosen = f.anim.value;
  const name = f.name.value.trim();
  const auto = themeFor({ name });
  f.anim.innerHTML = [
    ["", `自动（${auto ? THEMES[auto].label : "红包"}）`],
    ...Object.entries(THEMES).map(([k, t]) => [k, t.label]),
    ["envelope", "红包"],
  ].map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  f.anim.value = chosen;

  const chosenGroup = f.group.value;
  const autoLabel = TASK_GROUPS.find((g) => g.key === autoGroup({ name, anim: chosen })).label;
  f.group.innerHTML = [["", `自动（${autoLabel}）`], ...TASK_GROUPS.map((g) => [g.key, g.label])]
    .map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  f.group.value = chosenGroup;
}

function updateItemPreview() {
  setVisual($("#itemEditPreview"), { icon: $("#itemEditForm").icon.value.trim() || EDIT_KINDS[editKind].icon, image: editImage });
  $("#itemImageClear").classList.toggle("hidden", !editImage);
}

// Crop to a square and shrink to a small JPEG, so images stay light inside the family data.
async function resizeImage(file, size = 192) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openRecordEditor(rec) {
  const f = $("#recordEditForm");
  const d = new Date(rec.t);
  const p = (n) => String(n).padStart(2, "0");
  const buy = isPurchase(rec);
  editingRecordId = rec.id;
  f.when.value = `${dateKey(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
  f.when.max = `${dateKey()}T23:59`;
  f.points.value = buy ? rec.cost : rec.points;
  f.points.max = buy ? 999 : 99;
  $("#recordEditTitle").textContent = buy ? "修改兑换记录" : "修改任务记录";
  $("#recordPointsLabel").textContent = buy ? "花费星星" : "星星";
  $("#recordEditInfo").textContent = `${buy ? "兑换：" : ""}${rec.name} · ${byText(rec.by) || "提交人未知"}`;
  openEditor("#recordEditor");
}

function bindEditors() {
  document.querySelectorAll("#itemEditor, #recordEditor, #passwordEditor").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-close]")) closeEditors();
    });
  });
  addEventListener("keydown", (e) => e.key === "Escape" && closeEditors());

  const f = $("#itemEditForm");
  f.icon.addEventListener("input", updateItemPreview);
  f.name.addEventListener("input", updateAnimOptions);
  f.anim.addEventListener("change", updateAnimOptions);
  $("#animPreview").addEventListener("click", () =>
    celebrate({ name: f.name.value.trim(), anim: f.anim.value, points: clampInt(f.num.value, 1, 99) }),
  );
  $("#itemImageClear").addEventListener("click", () => {
    editImage = null;
    updateItemPreview();
  });
  $("#itemImageInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      editImage = await resizeImage(file);
      updateItemPreview();
    } catch {
      toast("这张图片打不开，换一张试试");
    }
  });

  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const k = EDIT_KINDS[editKind];
    const data = { icon: f.icon.value.trim() || k.icon, name: f.name.value.trim(), [k.numKey]: clampInt(f.num.value, 1, k.max) };
    if (!data.name) return;
    // Look the item up again: a family member's change may have replaced the state meanwhile.
    const list = k.list();
    const item = editingItemId && list.find((x) => x.id === editingItemId);
    if (editingItemId && !item) {
      toast(`这个${k.word}已经被家人删除了`);
    } else if (item) {
      Object.assign(item, data);
      if (editImage) item.image = editImage;
      else delete item.image;
    } else {
      list.push({ id: newId(k.prefix), ...data, ...(editImage ? { image: editImage } : {}) });
    }
    if (editKind === "task" && (item || !editingItemId)) {
      const saved = item || list[list.length - 1]; // the task just added
      if (f.anim.value) saved.anim = f.anim.value;
      else delete saved.anim; // automatic: follows the task name
      if (f.group.value) saved.group = f.group.value;
      else delete saved.group; // automatic: follows the animation
    }
    closeEditors();
    save();
    render();
    if (!editingItemId || item) toast(`${k.word}已${item ? "保存" : "添加"} ✅`);
  });

  $("#recordEditForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const rf = e.target;
    const t = new Date(rf.when.value).getTime(); // datetime-local values are parsed as local time
    if (!Number.isFinite(t)) return;
    if (t > Date.now() + 60e3) return toast("不能选将来的时间");
    const rec = state.records.find((r) => r.id === editingRecordId);
    const buy = state.redemptions.find((b) => b.id === editingRecordId);
    closeEditors();
    if (rec) updateRecord(rec, { t, points: clampInt(rf.points.value, 0, 99) });
    else if (buy) updateRedemption(buy, { t, cost: clampInt(rf.points.value, 0, 999) });
    else return toast("这条记录已经被家人删除了");
    save();
    render();
    toast("记录已修改 ✅");
  });
}

/* ---------------- UI helpers ---------------- */

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  if (name === "parent") renderParent();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Celebrations can overlap (task bonus, new badge), so show modals one after another.
const modalQueue = [];
function openModal(...args) {
  modalQueue.push(args);
  if (modalQueue.length === 1) showModal(...args);
}

function showModal(icon, title, text, buttons) {
  $("#modalIcon").textContent = icon;
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  const box = $("#modalBtns");
  box.innerHTML = "";
  for (const [label, cls, fn] of buttons) {
    const b = document.createElement("button");
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      $("#modal").classList.add("hidden");
      modalQueue.shift();
      fn?.();
      if (modalQueue.length) showModal(...modalQueue[0]);
    });
    box.append(b);
  }
  $("#modal").classList.remove("hidden");
}

function infoModal(icon, title, text) {
  openModal(icon, title, text, [["好的", "primary"]]);
}

function confirmModal(icon, title, text, okLabel, onOk) {
  openModal(icon, title, text, [
    ["再想想", ""],
    [okLabel, "primary", onOk],
  ]);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function randomCheer() {
  return `${pick(["真棒", "好厉害", "继续加油", "你做到了", "了不起", "太优秀了"])}！`;
}

function flyStars(fromEl, count) {
  const from = fromEl.getBoundingClientRect();
  const to = $("#balance").getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "fly-star";
    s.textContent = "⭐";
    const x = from.left + from.width * (0.6 + Math.random() * 0.3);
    const y = from.top + from.height / 2 - 14;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    document.body.append(s);
    setTimeout(() => {
      s.style.transform = `translate(${to.left + to.width / 2 - x - 14}px, ${to.top - y}px) scale(0.6)`;
      s.style.opacity = "0.2";
    }, 30 + i * 80);
    setTimeout(() => s.remove(), 900 + i * 80);
  }
}

/* ---------------- effects: fireworks, confetti, red envelope ---------------- */

// One canvas particle loop shared by confetti and fireworks, so they can overlap without flicker.
const fx = { parts: [], running: false, ctx: null };

function fxStart() {
  if (fx.running) return;
  const canvas = $("#confetti");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  fx.ctx = canvas.getContext("2d");
  fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fx.running = true;
  requestAnimationFrame(fxFrame);
}

function fxFrame() {
  const ctx = fx.ctx;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const born = [];
  for (const p of fx.parts) {
    p.life -= 1;
    if (FX_KINDS[p.kind]) {
      FX_KINDS[p.kind](ctx, p, born);
      continue;
    }
    if (p.kind === "rocket") {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += ROCKET_GRAVITY;
      ctx.fillStyle = "#fff6c2";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      born.push({ kind: "spark", x: p.x, y: p.y + 4, vx: (Math.random() - 0.5) * 0.6, vy: 1, life: 14, max: 14, color: "#ffcf6e", size: 1.6 });
      if (p.vy >= -1 || p.life <= 0) {
        p.life = 0;
        born.push(...burst(p.x, p.y, p.color));
      }
      continue;
    }
    p.vy += p.kind === "confetti" ? 0.35 : 0.06;
    p.vx *= p.kind === "confetti" ? 0.99 : 0.97;
    p.vy *= p.kind === "confetti" ? 1 : 0.97;
    p.x += p.vx;
    p.y += p.vy;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / (p.max * 0.5)));
    ctx.fillStyle = p.color;
    if (p.kind === "confetti") {
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  fx.parts = fx.parts.filter((p) => p.life > 0 && p.y < innerHeight + 40).concat(born);
  if (fx.parts.length) requestAnimationFrame(fxFrame);
  else {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    fx.running = false;
  }
}

// Particle kinds used by the task celebrations; each one moves and draws itself.
const FX_KINDS = {
  // Soap bubble that floats up, sways, and pops ("啵") when its life runs out.
  bubble(ctx, p, born) {
    p.t += 1;
    p.x += p.vx + Math.sin(p.t * p.freq) * p.sway;
    p.y += p.vy;
    p.vx *= 0.99;
    const r = p.r * Math.min(1, p.t / 10);
    const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.7, `hsla(${p.hue},90%,85%,0.18)`);
    g.addColorStop(1, `hsla(${p.hue + 60},90%,70%,0.35)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `hsla(${p.hue + p.t * 2},80%,65%,0.75)`;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.ellipse(p.x - r * 0.4, p.y - r * 0.45, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
    ctx.fill();
    if (p.life <= 0) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        born.push({ kind: "spark", x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: Math.cos(a) * 2, vy: Math.sin(a) * 2, life: 16, max: 16, size: 1.8, color: `hsl(${p.hue},90%,80%)` });
      }
      popSound();
    }
  },
  // Emoji or short text thrown up like a fountain, spinning and falling back down.
  emoji(ctx, p) {
    p.t += 1;
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    const grow = Math.min(1, p.t / 8);
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life / 20);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.font = `900 ${p.size * grow}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.color || "#000";
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  },
  // Sparkle that appears in place, twinkles, and fades.
  twinkle(ctx, p) {
    p.t += 1;
    const k = Math.sin((p.t / p.max) * Math.PI);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.font = `${p.size * (0.6 + 0.4 * k)}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
  },
};

let lastPop = 0;
function popSound() {
  const now = performance.now();
  if (now - lastPop < 45) return; // many bubbles popping together become a quick 啵啵啵, not noise
  lastPop = now;
  playSound("pop");
}

const rand = (a, b) => a + Math.random() * (b - a);

function spawnBubbles(cx, cy, n = 30) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      fx.parts.push({ kind: "bubble", x: cx + rand(-30, 30), y: cy + rand(-10, 10), vx: rand(-2.2, 2.2), vy: rand(-3.8, -1.6), sway: rand(0.4, 1.4), freq: rand(0.04, 0.09), t: 0, r: rand(8, 26), life: rand(55, 120), hue: rand(0, 360) });
      fxStart();
    }, i * 40);
  }
}

function spawnFountain(cx, cy, items, n = 22) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const it = pick(items);
      const [text, color] = Array.isArray(it) ? it : [it];
      // Thrown sideways from below the kid's face so nothing lands on it.
      fx.parts.push({ kind: "emoji", text, color, x: cx + rand(-20, 20), y: cy + 50, vx: (Math.random() < 0.5 ? -1 : 1) * rand(3, 6.5), vy: rand(-13, -7), g: 0.32, rot: rand(-0.4, 0.4), vr: rand(-0.08, 0.08), size: rand(26, 44), t: 0, life: 110 });
      fxStart();
    }, i * 45);
  }
}

function spawnTwinkles(items, n = 26, area = { x: 0, y: 0, w: innerWidth, h: innerHeight }) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const life = rand(45, 90);
      fx.parts.push({ kind: "twinkle", text: pick(items), x: area.x + rand(0, area.w), y: area.y + rand(0, area.h), size: rand(18, 36), t: 0, life, max: life });
      fxStart();
    }, i * 50);
  }
}

// Balloons and friends' toys drifting up into the sky.
function spawnFloaters(cx, cy, items, n = 18) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      // Rise along the left and right edges, drifting outward, so balloons never cover the kids' faces.
      const side = i % 2 ? 1 : -1;
      const x = Math.min(innerWidth - 20, Math.max(20, cx + side * rand(150, 200)));
      fx.parts.push({ kind: "emoji", text: pick(items), x, y: cy + rand(40, 180), vx: side * rand(0.2, 0.9), vy: rand(-4, -2.2), g: -0.03, rot: rand(-0.2, 0.2), vr: rand(-0.01, 0.01), size: rand(28, 46), t: 0, life: 130 });
      fxStart();
    }, i * 60);
  }
}

// Floating "Z z z" for the bedtime animation.
function spawnZzz(x, y) {
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      fx.parts.push({ kind: "emoji", text: i % 2 ? "z" : "Z", color: "#cfe3ff", x, y, vx: rand(0.8, 1.6), vy: -1.6, g: 0, rot: rand(-0.2, 0.2), vr: 0, size: 22 + i * 6, t: 0, life: 90 });
      fxStart();
    }, i * 260);
  }
}

const ROCKET_GRAVITY = 0.25; // rockets reach the top of the screen in about a second
const FX_COLORS = ["#ff9f43", "#ffd23f", "#2ecc71", "#54a0ff", "#ff6b9d", "#a55eea", "#ff4757"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function burst(x, y, color) {
  const n = 70;
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.2;
    const speed = 2.5 + Math.random() * 3.5;
    const life = 55 + Math.random() * 30;
    return { kind: "spark", x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, max: life, size: 2 + Math.random() * 1.5, color: Math.random() < 0.8 ? color : "#fff" };
  });
}

// Launch rockets from the bottom that explode at (x, y); positions default to the upper screen.
function fireworks(count = 3, { spread = 300, sound = true } = {}) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const x = innerWidth / 2 + (Math.random() - 0.5) * Math.min(spread * 2, innerWidth * 0.9);
      const y = innerHeight * (0.15 + Math.random() * 0.25);
      const vy = -Math.sqrt(2 * ROCKET_GRAVITY * (innerHeight - y)); // just enough speed to peak at y
      fx.parts.push({ kind: "rocket", x, y: innerHeight, vx: (Math.random() - 0.5) * 1.2, vy, life: 200, color: pick(FX_COLORS) });
      fxStart();
      if (sound) playSound("firework");
    }, i * 380);
  }
}

function confetti() {
  for (let i = 0; i < 140; i++) {
    fx.parts.push({
      kind: "confetti",
      x: innerWidth / 2,
      y: innerHeight / 3,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 12 - 4,
      size: 6 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      life: 150,
      max: 300,
      color: pick(FX_COLORS),
    });
  }
  fxStart();
}

// A red envelope pops up, shakes, opens and shows the stars earned, then the stars fly to the wallet.
function redEnvelope(points, cheer) {
  document.querySelectorAll(".rp-overlay, .scene-overlay").forEach((o) => o.remove()); // quick taps: show only the newest one
  const overlay = document.createElement("div");
  overlay.className = "rp-overlay";
  overlay.innerHTML = `
    <div class="rp">
      <div class="rp-card"><small>${cheer}</small><b>+${points}<span>⭐</span></b></div>
      <div class="rp-body"></div>
      <div class="rp-flap"><div class="rp-seal">奖</div></div>
    </div>`;
  document.body.append(overlay);
  playSound("redPacket");
  setTimeout(() => {
    overlay.classList.add("open");
    playSound("coins");
    fireworks(2, { spread: 140, sound: false });
  }, 650);
  setTimeout(() => flyStars(overlay.querySelector(".rp-card"), Math.min(points, 6)), 1150);
  setTimeout(() => overlay.classList.add("leave"), 1500);
  setTimeout(() => overlay.remove(), 1900);
}

/* ---------------- task celebrations: a kid doing the task, themed particles and sounds ---------------- */

// Matched against the task name in this order ("午饭刷牙" must be brushing, not eating).
// Each theme has an illustration in assets/anim/<key>.webp and a sound in SOUNDS[<key>].
const THEMES = {
  brush: { label: "刷牙泡泡", words: ["刷牙", "漱口"], motion: "wiggle", praise: ["牙齿亮晶晶！", "刷得真干净！", "泡泡飞上天啦！"],
    play: ({ cx, cy, size }) => spawnBubbles(cx, cy + size * 0.05) },
  wash: { label: "洗手", words: ["洗手", "洗脸"], motion: "shake", praise: ["小手洗得香喷喷！", "细菌都跑光啦！", "洗手小卫士！"],
    play: ({ cx, cy, size }) => { spawnBubbles(cx, cy + size * 0.2, 22); spawnFountain(cx, cy, ["💧", "💦", "🧼", "✨"], 14); } },
  hair: { label: "洗头", words: ["洗头", "洗发"], motion: "nod", praise: ["头发洗得香香的！", "不怕水，真勇敢！", "洗头小勇士！"],
    play: ({ cx, cy, size }) => { spawnBubbles(cx, cy - size * 0.2, 24); spawnFountain(cx, cy, ["💧", "💦", "🫧", "🧴"], 12); } },
  bath: { label: "洗澡", words: ["洗澡", "泡澡", "沐浴"], motion: "wiggle", praise: ["洗得香香的！", "泡泡澡真好玩！", "干干净净小宝贝！"],
    play: ({ cx, cy, size }) => { spawnBubbles(cx, cy - size * 0.1, 36); spawnFountain(cx, cy, ["🦆", "🫧", "💧", "🧴"], 10); } },
  potty: { label: "拉臭臭", words: ["大便", "拉臭臭", "便便", "上厕所", "如厕", "小便", "尿尿"], motion: "pop", praise: ["拉臭臭真棒！", "肚子舒服啦！", "自己上厕所真能干！"],
    play: ({ cx, cy }) => { spawnFountain(cx, cy, ["💩", "🧻", "👍", "⭐", "✨", "🌟"], 24); spawnTwinkles(["✨", "🌟"], 16); } },
  chat: { label: "聊天", words: ["聊天", "谈心", "说说", "讲讲"], motion: "nod", praise: ["和爸爸妈妈聊得真开心！", "你讲得真好！", "爸爸妈妈最爱听你说话！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["💬", "🗨️", "💭", "💖", "😊", "💬"]); spawnTwinkles(["✨", "💕"], 12); } },
  kindergarten: { label: "幼儿园一起玩", words: ["幼儿园", "上学", "学校", "托班", "分享", "打招呼", "谢谢", "礼貌"], motion: "dance", praise: ["和小朋友玩得真开心！", "幼儿园真好玩！", "交到好朋友啦！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🎈", "🎈", "🎈", "🪁", "🌈", "💖", "⭐"]); spawnTwinkles(["✨", "💫"], 14); } },
  hike: { label: "爬山", words: ["爬山", "登山", "徒步", "远足"], motion: "tilt", praise: ["爬到山顶啦！", "小小登山家！", "腿脚真有劲！"],
    play: ({ cx, cy }) => { spawnFountain(cx, cy, ["⛰️", "🌲", "🚩", "🦅", "⭐", "🌟"], 24); spawnTwinkles(["☀️", "✨"], 10); } },
  park: { label: "公园放风筝", words: ["公园", "风筝", "郊游", "野餐"], motion: "dance", praise: ["公园真好玩！", "风筝飞得高高的！", "玩得真开心！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🪁", "🪁", "🎈", "🦋", "🌸", "☁️"]); spawnTwinkles(["🌼", "✨"], 12); } },
  outdoor: { label: "户外玩耍", words: ["户外", "晒太阳", "散步", "滑梯", "浇水", "浇花"], motion: "dance", praise: ["晒晒太阳长得高！", "户外真好玩！", "大自然真美！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🦋", "🌸", "🍃", "🐦", "🌼", "🦋"]); spawnTwinkles(["☀️", "✨", "🌈"], 12); } },
  lookfar: { label: "看远处", words: ["看外面", "外面", "远处", "远眺", "望远", "护眼"], motion: "breathe", praise: ["眼睛休息好啦！", "看得好远好远！", "眼睛亮晶晶！"],
    play: () => spawnTwinkles(["✨", "🌤️", "🍃"], 14) },
  sleep: { label: "睡觉", words: ["睡"], motion: "breathe", praise: ["早睡早起身体好！", "做个甜甜的梦！"],
    play: ({ cx, cy, size }) => { spawnZzz(cx + size * 0.25, cy - size * 0.25); spawnTwinkles(["⭐", "✨", "🌟"], 30); } },
  class: { label: "上课举手", words: ["上课", "课堂", "听课", "兴趣班"], motion: "dance", praise: ["上课真认真！", "积极举手真勇敢！", "又学会新本领啦！"],
    play: ({ cx, cy }) => { spawnFountain(cx, cy, ["🙋", "✋", "💡", "👍", "⭐", "📚", "🔔"], 24); spawnTwinkles(["💡", "✨"], 14); } },
  math: { label: "学数学", words: ["数学", "算术", "口算", "数数", "加法", "减法"], motion: "pop", praise: ["数学小天才！", "算得又快又对！", "数字真好玩！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, [["1", "#e53935"], ["2", "#f9a825"], ["3", "#1e88e5"], ["5", "#fb8c00"], ["10", "#8e24aa"], ["+", "#43a047"], ["=", "#e53935"], "🧮", "⭐"], 28) },
  // Before art: "动画片" contains "画".
  cartoon: { label: "看动画片", words: ["动画片", "动画", "看电视", "电视"], motion: "tilt", praise: ["动画片真好看！", "看完啦，眼睛休息一下～", "哈哈真好笑！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🍿", "⭐", "🌈", "😆", "📺", "🍿"]); spawnTwinkles(["✨"], 10); } },
  tetris: { label: "俄罗斯方块", words: ["俄罗斯方块", "方块"], motion: "nod", praise: ["消除一整行！", "方块小高手！", "反应真快！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🟥", "🟨", "🟩", "🟦", "🟪", "⭐"], 24) },
  art: { label: "画画手工", words: ["画", "涂色", "手工", "剪纸", "折纸", "彩泥"], motion: "tilt", praise: ["小画家真棒！", "画得真漂亮！", "颜色好丰富！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🎨", "🖍️", "🖌️", "🌈", "☀️", "⭐"], 24) },
  guzheng: { label: "弹古筝", words: ["古筝", "琵琶", "钢琴", "弹琴", "练琴", "乐器"], motion: "nod", praise: ["琴声真好听！", "小小演奏家！", "弹得真棒！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🎵", "🎶", "🎼", "🌸", "🎵"]); spawnTwinkles(["✨"], 12); } },
  music: { label: "唱歌跳舞", words: ["唱歌", "儿歌", "跳舞", "音乐", "打鼓"], motion: "dance", praise: ["唱得真好听！", "小歌星来啦！", "跳得真好看！"],
    play: ({ cx, cy }) => { spawnFloaters(cx, cy, ["🎵", "🎶", "🎤", "💖", "⭐"]); spawnTwinkles(["✨", "🎵"], 12); } },
  // Before chess: "飞行棋" and "跳棋" are board games.
  boardgame: { label: "玩桌游", words: ["桌游", "飞行棋", "大富翁", "跳棋"], motion: "bounce", praise: ["玩得真开心！", "掷出好点数！", "桌游小高手！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🎲", "🎲", "♟️", "🃏", "⭐", "🏆"], 24) },
  chess: { label: "下棋", words: ["围棋", "象棋", "五子棋", "下棋"], motion: "nod", praise: ["小棋手真厉害！", "这步棋下得妙！", "动脑筋真棒！"],
    play: ({ cx, cy }) => { spawnFountain(cx, cy, ["⚫", "⚪", "⚫", "⚪", "🧠", "🏅", "⭐"], 24); spawnTwinkles(["💡", "✨"], 10); } },
  homework: { label: "写作业", words: ["作业", "写字", "练字", "功课", "数学", "英语", "算术", "学", "写"], motion: "nod", praise: ["作业完成啦！", "认真学习的好孩子！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["💯", "✏️", "⭐", "📝", ["A+", "#e53935"], ["100", "#e53935"]]) },
  read: { label: "读书", words: ["读", "阅读", "绘本", "书", "故事", "认字", "识字", "古诗", "背诗"], motion: "tilt", praise: ["读书真棒！", "又学到新知识啦！", "故事真好听！"],
    play: ({ cx, cy, size }) => spawnFountain(cx, cy + size * 0.2, ["⭐", "✨", "🦋", "🌈", "🦕", "🏰", ["A", "#54a0ff"], ["B", "#ff6b9d"], ["乐", "#2ecc71"]]) },
  bike: { label: "骑自行车", words: ["自行车", "单车", "骑车", "滑板车", "平衡车"], motion: "ride", praise: ["骑得真稳！", "小车手出发啦！", "叮铃铃，真厉害！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🚲", "💨", "🔔", "⭐", "🌟", "💪"], 24) },
  foosball: { label: "桌面足球", words: ["桌面足球", "桌上足球", "足球", "踢球"], motion: "shake", praise: ["射门成功！", "进球啦！", "足球小明星！"],
    play: ({ cx, cy }) => { fireworks(2, { spread: 200, sound: false }); spawnFountain(cx, cy, ["⚽", "⚽", "🥅", "🏆", "⭐", ["GOAL!", "#e53935"]], 24); } },
  sport: { label: "运动", words: ["跳绳", "运动", "跑", "球", "游泳", "锻炼", "骑车", "跳", "操"], motion: "bounce", praise: ["身体棒棒！", "运动小健将！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["💪", "⚡", "❤️", "⭐", "💦", "🏅"], 26) },
  tidy: { label: "收拾整理", words: ["收拾", "整理", "打扫", "玩具", "叠", "扫", "碗筷", "擦", "垃圾", "家务"], motion: "shake", praise: ["房间亮堂堂！", "收拾小能手！"],
    play: ({ cx, cy }) => { spawnTwinkles(["✨", "🌟", "💫", "⭐"], 34); spawnFountain(cx, cy, ["🧸", "🧩", "⚽", "🚗"], 10); } },
  dress: { label: "穿衣服", words: ["穿衣", "衣服", "穿", "梳头"], motion: "pop", praise: ["自己穿衣真能干！", "穿得真整齐！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["👕", "👖", "🧦", "🧢", "👟", "🧤", "✨"]) },
  drink: { label: "喝水", words: ["喝水", "饮水", "喝牛奶", "喝奶"], motion: "nod", praise: ["咕咚咕咚，真解渴！", "多喝水身体棒！", "喝水小达人！"],
    play: ({ cx, cy, size }) => { spawnFountain(cx, cy, ["💧", "💧", "💦", "💙", "🫧", "✨"], 24); spawnBubbles(cx, cy + size * 0.15, 12); } },
  eat: { label: "吃饭", words: ["吃", "饭", "餐", "喝"], motion: "nod", praise: ["吃得香香的！", "光盘小能手！", "长高高啦！"],
    play: ({ cx, cy }) => spawnFountain(cx, cy, ["🍚", "🥦", "🌽", "🍗", "🥕", "🍎", "🥚", "🍅", "🥛", "💧"]) },
  // Last: words like "难" are generic, so a more specific theme above wins.
  challenge: { label: "勇敢挑战", words: ["难", "挑战", "勇敢", "坚持"], motion: "bounce", praise: ["你真勇敢！", "困难被你打败啦！", "挑战成功！"],
    play: ({ cx, cy }) => { fireworks(3, { spread: 220, sound: false }); spawnFountain(cx, cy, ["🏆", "🏅", "💪", "🚩", "⭐", "🌟"], 24); } },
};

/* Moving parts drawn over (front) or under (back) an illustration, in its 440×440 pixel coordinates,
   animated with SVG SMIL so they also run on iOS. Illustrations with a back layer have those parts
   erased to transparency (bike spokes, the jump rope) so the moving version shows instead. */
const spin = (dur) => `<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="${dur}" repeatCount="indefinite"/>`;
const once = (attr, values, begin, dur, extra = "") =>
  `<animate attributeName="${attr}" values="${values}" begin="${begin}s" dur="${dur}s" fill="freeze" ${extra}/>`;

const bikeWheel = (cx, cy) => `
  <g transform="translate(${cx} ${cy})">
    <circle r="42" fill="#eef2f6" stroke="#aab4be" stroke-width="4"/>
    <g>${[0, 45, 90, 135].map((a) => `<line x1="-40" x2="40" transform="rotate(${a})" stroke="#9aa5b1" stroke-width="3"/>`).join("")}
      <circle cy="-30" r="5" fill="#ff7043" stroke="#333" stroke-width="1.5"/>${spin("0.45s")}</g>
    <circle r="8" fill="#c7cdd3" stroke="#3a3a3a" stroke-width="2.5"/>
  </g>`;

// The jump rope swings from hand to hand: over the head, down in front, under the feet (while the
// kid is at the top of the hop), and back up behind (fainter).
const ropeD = (cy) => `M94 188 Q229 ${cy} 364 214`;
const ropeAnim = `
  <animate attributeName="d" dur="0.9s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.25;0.5;0.75;1"
    keySplines="0.5 0 1 1;0 0 0.5 1;0.5 0 1 1;0 0 0.5 1" values="${[-170, 260, 700, 260, -170].map(ropeD).join(";")}"/>
  <animate attributeName="stroke-opacity" dur="0.9s" repeatCount="indefinite" values="1;1;0.3;0.3;1" keyTimes="0;0.45;0.55;0.95;1"/>`;

// A stone drops onto the board from above, bounces once, and a gold ripple spreads out ("啪").
const goStone = (x, y, color, begin) => `
  <g transform="translate(${x} ${y})">
    <ellipse rx="5" ry="3" fill="none" stroke="#ffb703" stroke-width="5" opacity="0">
      ${once("rx", "5;40", begin + 0.25, 0.6)}${once("ry", "3;24", begin + 0.25, 0.6)}${once("opacity", "1;0", begin + 0.25, 0.6)}
    </ellipse>
    <g visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}s"/>
      <ellipse rx="12" ry="8.5" fill="${color}" stroke="#222" stroke-width="2.5"/>
      <ellipse cx="-4" cy="-3" rx="4" ry="2.2" fill="#fff" opacity="${color === "#fff" ? 0 : 0.4}"/>
      <animateTransform attributeName="transform" type="translate" values="0 -80;0 0;0 -10;0 0" keyTimes="0;0.6;0.8;1" begin="${begin}s" dur="0.4s" fill="freeze"/>
    </g>
  </g>`;

const drop = (begin) => `
  <ellipse cx="383" rx="3.5" ry="5" fill="#5bb8f5" opacity="0">
    <animate attributeName="cy" values="296;336" begin="${begin}s" dur="0.32s" repeatCount="3"/>
    <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" begin="${begin}s" dur="0.32s" repeatCount="3"/>
  </ellipse>`;

const tetrisBlock = (col, row, color) =>
  `<rect x="${314 + col * 24}" y="${168 + row * 24}" width="22" height="22" rx="4" fill="${color}" stroke="#1b1f3b" stroke-width="2"/>`;
const fall = (begin, dur, from = -230) =>
  `<animateTransform attributeName="transform" type="translate" values="0 ${from};0 0;0 -6;0 0" keyTimes="0;0.8;0.9;1" begin="${begin}s" dur="${dur}s" fill="freeze"/>`;

const bird = (y, begin, dur) => `
  <g transform="translate(-30 ${y})">
    <path d="M-12 0 Q-6 -8 0 0 Q6 -8 12 0" fill="none" stroke="#4a3b2a" stroke-width="3" stroke-linecap="round">
      <animate attributeName="d" values="M-12 0 Q-6 -8 0 0 Q6 -8 12 0;M-12 -4 Q-6 4 0 0 Q6 4 12 -4;M-12 0 Q-6 -8 0 0 Q6 -8 12 0" dur="0.35s" repeatCount="indefinite"/>
    </path>
    <animateTransform attributeName="transform" type="translate" values="40 ${y + 20};420 ${y - 10}" begin="${begin}s" dur="${dur}s" repeatCount="indefinite"/>
  </g>`;

// An emoji drawn in a rig, centered on (x, y).
const emo = (ch, x, y, size) => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${ch}</text>`;
// Shows `inner` (drawn around the origin) at (x, y) and `size`, popping in with an overshoot at `begin`.
const popIn = (inner, x, y, begin, size = 1) => `
  <g transform="translate(${x} ${y}) scale(${size})"><g transform="scale(0)">${inner}
    <animateTransform attributeName="transform" type="scale" values="0;1.35;1" keyTimes="0;0.6;1" begin="${begin}s" dur="0.35s" fill="freeze"/>
  </g></g>`;
// Gentle endless bobbing for something that has popped in.
const bob = (inner, dy = 5, dur = 0.8) =>
  `<g>${inner}<animateTransform attributeName="transform" type="translate" values="0 0;0 -${dy};0 0" dur="${dur}s" repeatCount="indefinite"/></g>`;
const pulseR = (x, y, r, begin, dur = 0.9, fill = "#fff", stroke = "#9ecbe8") =>
  `<circle cx="${x}" cy="${y}" r="0" fill="${fill}" stroke="${stroke}" stroke-width="2"><animate attributeName="r" values="0;${r};${r};0" keyTimes="0;0.3;0.8;1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></circle>`;
// Something flying along `path` once at `begin`, hidden before and after.
const flyOnce = (inner, path, begin, dur) => `
  <g visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}s"/><set attributeName="visibility" to="hidden" begin="${begin + dur}s"/>
    ${inner}<animateMotion path="${path}" begin="${begin}s" dur="${dur}s" fill="freeze"/></g>`;
const flagWave = (a, b, c) =>
  `<animate attributeName="d" values="${a};${b};${a};${c};${a}" dur="0.8s" repeatCount="indefinite"/>`;
// Points along the kindergarten bunting string (a quadratic curve).
const bunting = (t) => [(1 - t) ** 2 * 10 + 2 * (1 - t) * t * 280 + t ** 2 * 550, (1 - t) ** 2 * 20 + 2 * (1 - t) * t * 70 + t ** 2 * 20];

const RIGS = {
  // Foam bubbles froth at the mouth while scrub lines flash by the brush.
  brush: {
    front: `${[[208, 244, 7], [222, 238, 6], [232, 250, 8], [216, 258, 6], [240, 240, 5], [200, 256, 5], [228, 264, 5]].map(([x, y, r], i) => pulseR(x, y, r, i * 0.12)).join("")}
      <g fill="none" stroke="#5bb8f5" stroke-width="3" stroke-linecap="round"><path d="M128 230 q-8 -8 0 -16"/><path d="M116 236 q-10 -12 0 -24"/>
        <animate attributeName="opacity" values="1;0.15;1" dur="0.3s" repeatCount="indefinite"/></g>`,
  },
  // Water pours from the big cup onto the hair, splashes, and drips off; shampoo bubbles float up.
  hair: {
    front: `${[["#7cc8f8", 15, 0.8], ["#fff", 4, 0.9]].map(([color, w, op], i) => `
      <path d="M218 80 Q228 92 231 116" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" opacity="${op}" ${i ? 'stroke-dasharray="5 9"' : ""}>
        ${i ? '<animate attributeName="stroke-dashoffset" values="28;0" dur="0.3s" repeatCount="indefinite"/>' : '<animate attributeName="stroke-width" values="15;19;15" dur="0.25s" repeatCount="indefinite"/>'}</path>`).join("")}
      ${[["M231 114 q-18 -16 -34 2", 0], ["M231 114 q16 -18 34 0", 0.15], ["M231 114 q-8 -22 -20 -8", 0.3], ["M231 114 q10 -20 22 -6", 0.45]].map(([d, b]) =>
        `<circle r="5" fill="#7cc8f8" stroke="#fff" stroke-width="1"><animateMotion path="${d}" begin="${b}s" dur="0.5s" repeatCount="indefinite"/></circle>`).join("")}
      ${[[146, 180, 0.2], [342, 176, 0.5], [160, 210, 0.8], [330, 214, 1.1], [150, 196, 1.4]].map(([x, y, b]) => `
        <path d="M0 -7 Q6 2 0 5 Q-6 2 0 -7Z" fill="#7cc8f8" stroke="#3a8fd0" stroke-width="1.2" transform="translate(${x} ${y})" opacity="0">
          <animateTransform attributeName="transform" type="translate" values="${x} ${y};${x} ${y + 70}" begin="${b}s" dur="0.8s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="1;1;0" begin="${b}s" dur="0.8s" repeatCount="indefinite"/></path>`).join("")}
      ${[[200, 110], [270, 104], [300, 128]].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="#9ecbe8" stroke-width="2">
        <animate attributeName="cy" values="${y};${y - 80}" dur="1.1s" begin="${i * 0.35}s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.1s" begin="${i * 0.35}s" repeatCount="indefinite"/></circle>`).join("")}`,
  },
  // Shampoo foam puffs on the head, bubbles float off it, water splashes over the tub rim.
  bath: {
    front: `${[[212, 50, 12], [232, 36, 14], [256, 30, 13], [280, 38, 12], [298, 52, 10], [244, 52, 9], [270, 54, 9]].map(([x, y, r], i) =>
        `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="#cfe6f5" stroke-width="2"><animate attributeName="r" values="${r};${r * 1.25};${r}" dur="0.6s" begin="${i * 0.08}s" repeatCount="indefinite"/></circle>`).join("")}
      ${[230, 255, 285].map((x, i) => `<circle cx="${x}" cy="30" r="5" fill="none" stroke="#9ecbe8" stroke-width="2">
        <animate attributeName="cy" values="30;-40" dur="1s" begin="${i * 0.3}s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1s" begin="${i * 0.3}s" repeatCount="indefinite"/></circle>`).join("")}
      ${[["M70 300 q-14 -30 -30 -4", 0], ["M390 300 q16 -30 32 -2", 0.25], ["M90 295 q-6 -34 -20 -8", 0.5]].map(([p, b]) =>
        `<circle r="4" fill="#7cc8f8"><animateMotion path="${p}" begin="${b}s" dur="0.7s" repeatCount="indefinite"/></circle>`).join("")}`,
  },
  // The toilet paper unrolls and flutters; sparkles for a job well done.
  potty: {
    front: `<g fill="none" stroke-linecap="round">
      ${[["#bdbdbd", 15], ["#fff", 11]].map(([color, w]) => `<path d="M372 382 C395 380 405 405 430 400" stroke="${color}" stroke-width="${w}">
        <animate attributeName="d" values="M372 382 C395 380 405 405 430 400;M372 382 C395 396 412 380 438 392;M372 382 C395 380 405 405 430 400" dur="0.7s" repeatCount="indefinite"/></path>`).join("")}</g>
      ${popIn(bob(emo("✨", 0, 0, 30)), 80, 70, 0.4)}${popIn(bob(emo("🌟", 0, 0, 28), 6, 0.7), 340, 60, 0.7)}`,
  },
  // Speed lines whoosh along the slide and a puff of air at the bottom.
  outdoor: {
    front: `${[[40, 196], [22, 232], [62, 166]].map(([x, y], i) => `
      <g stroke-linecap="round" opacity="0">${[["#4a3b2a", 9], ["#fff", 4]].map(([color, w]) => `<line x1="${x}" y1="${y}" x2="${x + 48}" y2="${y + 36}" stroke="${color}" stroke-width="${w}"/>`).join("")}
        <animateTransform attributeName="transform" type="translate" from="0 0" to="-36 -27" begin="${i * 0.15}s" dur="0.45s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;0" begin="${i * 0.15}s" dur="0.45s" repeatCount="indefinite"/></g>`).join("")}
      <g transform="translate(404 340)">${emo("💨", 0, 0, 52)}<animateTransform attributeName="transform" type="scale" values="0.6;1.3;0.6" dur="0.6s" repeatCount="indefinite" additive="sum"/></g>
      ${flyOnce(emo("🌸", 0, 0, 22), "M60 400 q20 -80 -10 -160", 0.2, 1.6)}${flyOnce(emo("🌼", 0, 0, 22), "M380 410 q-20 -90 20 -170", 0.6, 1.6)}`,
  },
  // A little flag springs up on the mountain top and flaps; an eagle soars past.
  hike: {
    front: `<g transform="translate(350 198) scale(2)"><g transform="scale(1 0)">
        <line y2="-46" stroke="#5a3a1a" stroke-width="3"/>
        <path fill="#ff5252" stroke="#7a1d14" stroke-width="2" d="M0 -46 Q14 -50 28 -44 L28 -30 Q14 -36 0 -32 Z">
          ${flagWave("M0 -46 Q14 -50 28 -44 L28 -30 Q14 -36 0 -32 Z", "M0 -46 Q14 -40 28 -48 L28 -34 Q14 -26 0 -32 Z", "M0 -46 Q14 -54 28 -40 L28 -26 Q14 -40 0 -32 Z")}</path>
        <animateTransform attributeName="transform" type="scale" values="1 0;1 1.2;1 1" keyTimes="0;0.7;1" begin="0.4s" dur="0.35s" fill="freeze"/>
      </g></g>
      ${bird(60, 0.2, 2.4)}`,
  },
  // Wind swirls blow across the sky and leaves tumble by.
  park: {
    front: `${[["M0 44 q40 -30 80 0 t80 0", 0], ["M150 12 q35 -26 70 0 t70 0", 0.4]].map(([d, b]) => `
      <path d="${d}" fill="none" stroke="#9ad0ff" stroke-width="5" stroke-linecap="round" stroke-dasharray="40 260">
        <animate attributeName="stroke-dashoffset" values="300;0" begin="${b}s" dur="1.1s" repeatCount="indefinite"/></path>`).join("")}
      ${flyOnce(emo("🍃", 0, 0, 24), "M-10 120 q120 -60 240 10 t220 -20", 0.1, 1.8)}${flyOnce(emo("🍂", 0, 0, 22), "M-10 230 q100 -50 200 0 t250 -40", 0.7, 1.8)}`,
  },
  // Counting sheep hop over a little fence: "1", "2" ...
  sleep: {
    front: `<g stroke="#c8a165" stroke-width="6" stroke-linecap="round"><line x1="376" y1="36" x2="376" y2="84"/><line x1="410" y1="36" x2="410" y2="84"/>
        <line x1="364" y1="50" x2="422" y2="50"/><line x1="364" y1="70" x2="422" y2="70"/></g>
      <g transform="translate(300 74)"><g transform="translate(0 -10) scale(1.6)">
        <g fill="#fff" stroke="#8a8a9a" stroke-width="2"><circle cx="-8" cy="-6" r="9"/><circle cx="4" cy="-9" r="10"/><circle cx="12" cy="-3" r="8"/><circle cx="0" cy="0" r="9"/></g>
        <circle cx="20" cy="-8" r="6" fill="#4a3b2a"/><g stroke="#4a3b2a" stroke-width="3"><line x1="-6" y1="6" x2="-6" y2="14"/><line x1="8" y1="6" x2="8" y2="14"/></g></g>
        <animateTransform attributeName="transform" type="translate" values="300 74;393 -6;470 74" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.2 0.6 0.4 1;0.6 0 0.8 0.4" dur="1.3s" repeatCount="indefinite"/>
      </g>
      ${[["1", 0.5], ["2", 1.8]].map(([n, b]) => `<text x="393" y="-14" text-anchor="middle" font-size="34" font-weight="900" fill="#ffd23f" opacity="0">${n}
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.2;0.7;1" begin="${b}s" dur="0.9s" fill="freeze"/>
        <animate attributeName="y" values="-20;-44" begin="${b}s" dur="0.9s" fill="freeze"/></text>`).join("")}`,
  },
  // A light bulb pops up over the head and switches on (a bright idea!), and the raised hand waves.
  class: {
    front: `${popIn(`
        <g opacity="0">${once("opacity", "0;1", 0.6, 0.1)}<g>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line y1="-28" y2="-38" transform="rotate(${a})" stroke="#ffb703" stroke-width="4" stroke-linecap="round"/>`).join("")}
          <animateTransform attributeName="transform" type="scale" values="1;1.15;1" dur="0.5s" repeatCount="indefinite"/></g></g>
        <path d="M-14 4 a18 18 0 1 1 28 0 q-4 5 -5 10 h-18 q-1 -5 -5 -10z" fill="#e8e8e8" stroke="#4a3b2a" stroke-width="3">${once("fill", "#e8e8e8;#ffe14d", 0.6, 0.1)}</path>
        <rect x="-9" y="15" width="18" height="9" rx="2" fill="#9aa5b1" stroke="#4a3b2a" stroke-width="2.5"/>`, 350, 52, 0.2, 1.6)}
      <g fill="none" stroke="#ff9f43" stroke-width="4" stroke-linecap="round"><path d="M50 30 q-10 14 0 28"/><path d="M36 24 q-14 20 0 40"/>
        <animate attributeName="opacity" values="1;0.1;1" dur="0.5s" repeatCount="indefinite"/></g>`,
  },
  // "1 + 2 = 3 ✓" pops up above the head, chip by chip.
  math: {
    front: [["1", "#e53935"], ["+", "#43a047"], ["2", "#f9a825"], ["=", "#8e24aa"], ["3", "#1e88e5"], ["✓", "#2ecc71"]].map(([ch, color], i) =>
      popIn(`<circle r="22" fill="#fff" stroke="${color}" stroke-width="4"/><text text-anchor="middle" dominant-baseline="central" font-size="28" font-weight="900" fill="${color}">${ch}</text>`, 105 + i * 46, -20, 0.3 + i * 0.18)).join(""),
  },
  // A heart gets painted on the canvas stroke by stroke, with dabs of paint around it.
  art: {
    front: `<path d="M140 250 C116 232 120 208 140 220 C160 208 164 232 140 250 Z" fill="#ff8fab" fill-opacity="0" stroke="#ff4d6d" stroke-width="5" stroke-linejoin="round" stroke-dasharray="130" stroke-dashoffset="130">
        ${once("stroke-dashoffset", "130;0", 0.3, 0.8)}${once("fill-opacity", "0;1", 1.1, 0.3)}</path>
      ${[[112, 266, "#ffd23f"], [168, 254, "#54a0ff"], [118, 202, "#2ecc71"], [166, 212, "#a55eea"]].map(([x, y, color], i) => popIn(`<circle r="7" fill="${color}" stroke="#4a3b2a" stroke-width="1.5"/>`, x, y, 0.5 + i * 0.25)).join("")}`,
  },
  // Notes hop onto a little music staff above the head.
  guzheng: {
    front: `<g stroke="#8d6e4a" stroke-width="2" opacity="0.8">${[-44, -36, -28, -20, -12].map((y) => `<line x1="110" x2="330" y1="${y}" y2="${y}"/>`).join("")}</g>
      ${[[140, -16, "#e53935"], [180, -28, "#f9a825"], [220, -20, "#43a047"], [260, -36, "#1e88e5"], [300, -24, "#8e24aa"]].map(([x, y, color], i) =>
        popIn(bob(`<ellipse rx="7" ry="5" transform="rotate(-20)" fill="${color}"/><line x1="6" y1="0" x2="6" y2="-24" stroke="${color}" stroke-width="2.5"/>`, 4, 0.6), x, y, 0.3 + i * 0.2)).join("")}`,
  },
  // Sound waves ring out of the microphone while equalizer bars dance in the corner.
  music: {
    front: `<g transform="translate(140 256)">${[0, 0.3, 0.6].map((b) => `
        <path d="M-24 -22 A32 32 0 0 0 -24 22" fill="none" stroke="#ff6b9d" stroke-width="4" stroke-linecap="round" opacity="0">
          <animate attributeName="opacity" values="0;1;0" begin="${b}s" dur="0.9s" repeatCount="indefinite"/>
          <animateTransform attributeName="transform" type="scale" values="0.7;1.6" begin="${b}s" dur="0.9s" repeatCount="indefinite"/></path>`).join("")}</g>
      ${["#ff6b6b", "#ffd23f", "#2ecc71", "#54a0ff", "#a55eea"].map((color, i) => `
        <rect x="${368 + i * 15}" width="12" rx="3" fill="${color}" stroke="#4a3b2a" stroke-width="1.5" y="400" height="30">
          <animate attributeName="height" values="${[30, 60, 20, 50, 30].map((h) => (h + i * 7) % 70 + 10).join(";")}" dur="${0.5 + i * 0.07}s" repeatCount="indefinite"/>
          <animate attributeName="y" values="${[30, 60, 20, 50, 30].map((h) => 430 - ((h + i * 7) % 70 + 10)).join(";")}" dur="${0.5 + i * 0.07}s" repeatCount="indefinite"/></rect>`).join("")}`,
  },
  // A game piece hops three squares along the board: +3!
  boardgame: {
    front: `<g><g transform="translate(0 -2)">
        <path d="M-8 0 L8 0 L4 -14 L-4 -14 Z" fill="#a55eea" stroke="#3d1f5c" stroke-width="2"/><circle cy="-19" r="7" fill="#a55eea" stroke="#3d1f5c" stroke-width="2"/></g>
        <animateMotion path="M110 334 q30 -46 60 0 q30 -46 60 0 q30 -46 60 0" begin="0.3s" dur="1.4s" fill="freeze" calcMode="linear"/></g>
      ${popIn(`<text text-anchor="middle" dominant-baseline="central" font-size="28" font-weight="900" fill="#e53935" stroke="#fff" stroke-width="1.5">+3</text>`, 290, 280, 1.7)}`,
  },
  // Neat handwriting appears on the page, then a red "100" stamp thumps down.
  homework: {
    front: `${[["M236 346 q6 -7 12 0 t12 0 t12 0 t12 0 t12 0 t12 0", 0.2], ["M236 360 q6 -7 12 0 t12 0 t12 0 t12 0", 0.8]].map(([d, b]) => `
      <path d="${d}" fill="none" stroke="#4a4a4a" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="170" stroke-dashoffset="170">${once("stroke-dashoffset", "170;0", b, 0.6)}</path>`).join("")}
      <g transform="translate(300 330) rotate(-12)"><g transform="scale(0)">
        <text text-anchor="middle" dominant-baseline="central" font-size="30" font-weight="900" fill="#e53935">100</text>
        <path d="M-26 16 H26 M-22 22 H22" stroke="#e53935" stroke-width="3"/>
        <animateTransform attributeName="transform" type="scale" values="2.2;0.9;1" keyTimes="0;0.7;1" begin="1.35s" dur="0.3s" fill="freeze"/>
      </g></g>`,
  },
  // Friends from the story pop up out of the book.
  read: {
    front: [["🦕", 96, 0.3, 22], ["🐰", 334, 0.6, 22], ["🦋", 380, 0.9, 120]].map(([ch, x, b, rise]) => `
      <g transform="translate(${x} 232)"><g visibility="hidden"><set attributeName="visibility" to="visible" begin="${b}s"/>
        ${bob(emo(ch, 0, 0, 46), 6, 0.7)}
        <animateTransform attributeName="transform" type="translate" values="0 10;0 -${rise + 12};0 -${rise}" keyTimes="0;0.7;1" begin="${b}s" dur="0.5s" fill="freeze"/>
      </g></g>`).join(""),
  },
  // Toys fly in one after another and drop into the toy box, each with a sparkle.
  tidy: {
    front: [["⚽", 0.2], ["🚗", 0.65], ["🧩", 1.1], ["🦖", 1.55]].map(([ch, b], i) =>
      flyOnce(emo(ch, 0, 0, 30), `M${440 - i * 10} ${70 + i * 12} Q${360 - i * 10} 40 ${300 + i * 12} 290`, b, 0.55) +
      `<g opacity="0">${emo("✨", 300 + i * 12, 270, 26)}${once("opacity", "0;1;0", b + 0.55, 0.4)}</g>`).join(""),
  },
  // A shirt swings on its hanger and a sock hops about.
  dress: {
    front: `<g transform="translate(392 12) scale(1.3)"><g>
        <path d="M0 0 q0 -10 8 -10 q8 0 6 8" fill="none" stroke="#8d5524" stroke-width="3"/>
        <path d="M0 4 L-30 26 L30 26 Z" fill="none" stroke="#8d5524" stroke-width="3" stroke-linejoin="round"/>
        ${emo("👕", 0, 50, 44)}
        <animateTransform attributeName="transform" type="rotate" values="-14;14;-14" dur="1.2s" repeatCount="indefinite"/></g></g>
      <g transform="translate(34 236)">${bob(emo("🧦", 0, 0, 44), 18, 0.5)}</g>`,
  },
  // The flag flaps in the wind (drawn over the illustration's still flag).
  challenge: {
    front: `<path fill="#f2463a" stroke="#7a1d14" stroke-width="3" stroke-linejoin="round" d="M330 106 Q372 112 422 146 Q414 178 416 210 Q366 196 314 184 Z">
      ${flagWave("M330 106 Q372 112 422 146 Q414 178 416 210 Q366 196 314 184 Z", "M330 106 Q370 126 422 140 Q410 178 418 204 Q366 206 314 184 Z", "M330 106 Q376 104 424 150 Q418 176 414 212 Q368 194 314 184 Z")}</path>`,
  },
  // A heart, a smile and a star pop into the speech bubbles.
  chat: {
    box: "0 0 560 398",
    front: [["❤️", 190, 40, 0.3], ["😊", 275, 40, 0.65], ["🌟", 352, 58, 1]].map(([ch, x, y, b]) => popIn(bob(emo(ch, 0, 0, 30), 4, 0.7), x, y, b)).join(""),
  },
  // A string of party flags sways above the friends.
  kindergarten: {
    box: "0 0 560 527",
    front: `<path d="M10 20 Q280 70 550 20" fill="none" stroke="#8d5524" stroke-width="3"/>
      ${["#ff6b6b", "#ffd23f", "#2ecc71", "#54a0ff", "#a55eea", "#ff9f43", "#48dbfb", "#ff6b9d"].map((color, i) => {
        const [x, y] = bunting(0.08 + i * 0.12);
        return `<g transform="translate(${x} ${y})"><path d="M-13 0 L13 0 L0 26 Z" fill="${color}" stroke="#4a3b2a" stroke-width="1.5">
          <animateTransform attributeName="transform" type="rotate" values="${i % 2 ? "-10;10;-10" : "10;-10;10"}" dur="0.9s" repeatCount="indefinite"/></path></g>`;
      }).join("")}`,
  },
  bike: {
    back: bikeWheel(150, 364) + bikeWheel(355, 366),
    front: `
      <clipPath id="rigRoad"><rect x="10" y="420" width="420" height="20"/></clipPath>
      <g clip-path="url(#rigRoad)"><g stroke="#c9b8a0" stroke-width="5" stroke-linecap="round">
        ${[-60, 60, 180, 300, 420].map((x) => `<line x1="${x}" y1="432" x2="${x + 50}" y2="432"/>`).join("")}
        <animateTransform attributeName="transform" type="translate" from="0 0" to="-120 0" dur="0.45s" repeatCount="indefinite"/>
      </g></g>
      ${[290, 306, 322].map((y, i) => `
        <line x1="40" y1="${y}" x2="80" y2="${y}" stroke="#54a0ff" stroke-width="4" stroke-linecap="round" opacity="0">
          <animateTransform attributeName="transform" type="translate" from="0 0" to="-36 0" begin="${i * 0.15}s" dur="0.45s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.9;0" begin="${i * 0.15}s" dur="0.45s" repeatCount="indefinite"/>
        </line>`).join("")}`,
  },
  sport: {
    front: `<g fill="none" stroke-linecap="round">
      <path d="${ropeD(-170)}" stroke="#7a1f1f" stroke-width="10">${ropeAnim}</path>
      <path d="${ropeD(-170)}" stroke="#e53935" stroke-width="6">${ropeAnim}</path></g>`,
  },
  // The ball rolls back and forth between the two goals (the drawn ball is covered with field green).
  foosball: {
    front: `
      <ellipse cx="233" cy="311" rx="9" ry="8" fill="#42a83a"/>
      <g>
        <g><circle r="7.5" fill="#fff" stroke="#222" stroke-width="2"/><circle cx="2.5" cy="-1" r="2.6" fill="#222"/>${spin("0.4s")}</g>
        <animateMotion path="M180 333 L247 284" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" dur="1.4s" repeatCount="indefinite"/>
      </g>`,
  },
  // New stones click onto the board one after another, each with a ripple.
  chess: {
    front: goStone(245, 340, "#fff", 0.35) + goStone(300, 352, "#222", 0.85) + goStone(210, 372, "#fff", 1.35) + goStone(332, 372, "#222", 1.8),
  },
  // Running tap water with little splashes in the basin.
  wash: {
    front: `<g fill="none" stroke-linecap="round">
      <path d="M164 343 L167 395" stroke="#d6f0ff" stroke-width="10" opacity="0.85"/>
      <path d="M164 343 L167 395" stroke="#5bb8f5" stroke-width="4" stroke-dasharray="9 7">
        <animate attributeName="stroke-dashoffset" from="0" to="-32" dur="0.3s" repeatCount="indefinite"/></path></g>
      ${[["M167 395 q-12 -22 -24 2", 0], ["M167 395 q10 -26 22 0", 0.2], ["M167 395 q-4 -30 -10 2", 0.4]].map(([path, begin]) => `
        <circle r="3" fill="#7cc8f8"><animateMotion path="${path}" begin="${begin}s" dur="0.6s" repeatCount="indefinite"/></circle>`).join("")}`,
  },
  // A droopy little flower gets watered and blooms.
  drink: {
    front: `<g transform="translate(400 432) scale(1.35) translate(-400 -432)">
      <g transform="translate(418 286)"><g>
        <path d="M-14 -2 L-32 -14" stroke="#1d3d6b" stroke-width="7" stroke-linecap="round"/>
        <path d="M-14 -2 L-32 -14" stroke="#54a0ff" stroke-width="3.5" stroke-linecap="round"/>
        <path d="M6 -12 q12 -12 16 4" fill="none" stroke="#1d3d6b" stroke-width="4"/>
        <rect x="-14" y="-12" width="28" height="22" rx="5" fill="#54a0ff" stroke="#1d3d6b" stroke-width="3"/>
        <animateTransform attributeName="transform" type="rotate" values="0;-35;-35;0" keyTimes="0;0.15;0.7;0.85" dur="1.8s" fill="freeze"/>
      </g></g>
      ${drop(0.35)}${drop(0.45)}${drop(0.55)}
      <path d="M378 392 h46 l-6 38 h-34 z" fill="#e07a4f" stroke="#4a2b1a" stroke-width="3" stroke-linejoin="round"/>
      <rect x="374" y="384" width="54" height="11" rx="4" fill="#ef8f63" stroke="#4a2b1a" stroke-width="3"/>
      <path d="M401 385 Q404 345 376 342" fill="none" stroke="#4caf50" stroke-width="5" stroke-linecap="round">
        ${once("d", "M401 385 Q404 345 376 342;M401 385 Q404 345 376 342;M401 385 Q398 350 401 318", 0, 1.8, 'keyTimes="0;0.55;1" calcMode="spline" keySplines="0 0 1 1;0.3 1.5 0.6 1"')}
      </path>
      <g transform="translate(401 368)"><g transform="rotate(50)">
        <path d="M0 0 q12 -10 22 -2 q-10 10 -22 2z" fill="#66bb6a" stroke="#2e7d32" stroke-width="2"/>
        <animateTransform attributeName="transform" type="rotate" values="50;50;-15" keyTimes="0;0.55;1" dur="1.8s" fill="freeze"/>
      </g></g>
      <g transform="translate(376 342)">
        <animateTransform attributeName="transform" type="translate" values="376 342;376 342;401 318" keyTimes="0;0.55;1" dur="1.8s" fill="freeze" calcMode="spline" keySplines="0 0 1 1;0.3 1.5 0.6 1"/>
        <g transform="rotate(80)"><animateTransform attributeName="transform" type="rotate" values="80;80;0" keyTimes="0;0.55;1" dur="1.8s" fill="freeze"/>
          <g transform="scale(0.6)"><animateTransform attributeName="transform" type="scale" values="0.6;0.6;1.3;1.15" keyTimes="0;0.6;0.85;1" dur="2s" fill="freeze"/>
            ${[0, 60, 120, 180, 240, 300].map((a) => `<ellipse cy="-12" rx="7" ry="11" transform="rotate(${a})" fill="#b9a7a0" stroke="#7a4a5a" stroke-width="1.5">${once("fill", "#b9a7a0;#b9a7a0;#ff6b9d", 0, 1.7, 'keyTimes="0;0.7;1"')}</ellipse>`).join("")}
            <circle r="7" fill="#c8b27a" stroke="#7a5a2a" stroke-width="1.5">${once("fill", "#c8b27a;#c8b27a;#ffd23f", 0, 1.7, 'keyTimes="0;0.7;1"')}</circle>
          </g>
        </g>
      </g></g>`,
  },
  // A battery charges from red to a full green 100%.
  eat: {
    front: `<g transform="translate(396 160)">
      <rect x="-10" y="-76" width="20" height="10" rx="3" fill="#4a3b2a"/>
      <rect x="-25" y="-68" width="50" height="130" rx="10" fill="#fff" stroke="#4a3b2a" stroke-width="5"/>
      <rect x="-18" y="48" width="36" height="8" rx="5" fill="#ee5253">
        ${once("height", "8;118", 0.2, 1.5)}${once("y", "48;-62", 0.2, 1.5)}${once("fill", "#ee5253;#ffd23f;#2ecc71", 0.2, 1.5)}
      </rect>
      <path d="M5 -32 L-11 4 H0 L-5 34 L13 -6 H2 Z" fill="#fff" stroke="#4a3b2a" stroke-width="2.5" stroke-linejoin="round">
        <animateTransform attributeName="transform" type="scale" values="1;1.2;1" dur="0.5s" repeatCount="indefinite"/>
      </path>
      <text y="-86" text-anchor="middle" font-size="24" font-weight="900" fill="#23995a" opacity="0">100%${once("opacity", "0;1", 1.7, 0.2)}</text>
    </g>
    <radialGradient id="eatGlow"><stop offset="0" stop-color="#fff59d" stop-opacity="0.95"/><stop offset="1" stop-color="#ffd23f" stop-opacity="0"/></radialGradient>
    ${["M396 82 C448 60 456 350 418 340", "M396 222 C346 240 346 350 386 340"].map((d) => `
      <path d="${d}" fill="none" stroke="#4a3b2a" stroke-width="4" stroke-linecap="round"/>
      <circle r="4" fill="#ffd23f" opacity="0"><animateMotion path="${d}" begin="0.2s" dur="0.6s" repeatCount="indefinite"/>${once("opacity", "0;1", 0.2, 0.1)}</circle>`).join("")}
    <g transform="translate(402 282) scale(1.3)">
      <circle r="24" fill="url(#eatGlow)" opacity="0">${once("r", "24;70", 0.2, 1.5)}${once("opacity", "0;1", 0.2, 1.5)}
        <animate attributeName="r" values="70;82;70" begin="1.7s" dur="0.5s" repeatCount="indefinite"/></circle>
      <g opacity="0">${once("opacity", "0;1", 1.5, 0.2)}<g>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line y1="-34" y2="-48" transform="rotate(${a})" stroke="#ffb703" stroke-width="5" stroke-linecap="round"/>`).join("")}
        <animateTransform attributeName="transform" type="scale" values="1;1.2;1" dur="0.5s" repeatCount="indefinite"/></g></g>
      <path d="M-22 0 a22 22 0 1 1 44 0 q0 12 -10 20 v8 h-24 v-8 q-10 -8 -10 -20z" fill="#eeeeee" stroke="#4a3b2a" stroke-width="3.5">
        ${once("fill", "#eeeeee;#fff3b0;#ffe14d;#ffd000", 0.2, 1.5)}</path>
      <path d="M-8 18 V6 l4 -8 l4 8 l4 -8 l4 8 V18" fill="none" stroke="#9e9e9e" stroke-width="2.5" stroke-linejoin="round">${once("stroke", "#9e9e9e;#ff9800;#e65100", 0.2, 1.5)}</path>
      <rect x="-13" y="28" width="26" height="14" rx="3" fill="#b0bec5" stroke="#4a3b2a" stroke-width="3"/>
      <path d="M-13 35 H13" stroke="#4a3b2a" stroke-width="2"/>
    </g>`,
  },
  // Blocks fall into the playfield, the bottom row fills up, flashes and clears.
  tetris: {
    front: `
      <rect x="308" y="160" width="128" height="276" rx="10" fill="#2d3561" stroke="#1b1f3b" stroke-width="4" opacity="0.92"/>
      <g>${once("opacity", "1;0", 1.3, 0.15)}
        ${tetrisBlock(0, 10, "#ff6b6b")}${tetrisBlock(1, 10, "#2ecc71")}${tetrisBlock(2, 10, "#54a0ff")}
        <g transform="translate(0 -230)">${fall(0.2, 0.7)}${tetrisBlock(3, 10, "#ffd23f")}${tetrisBlock(4, 10, "#ffd23f")}</g>
      </g>
      <rect x="312" y="406" width="120" height="24" rx="4" fill="#fff" opacity="0">${once("opacity", "0;0.95;0;0.95;0", 0.9, 0.4)}</rect>
      <g><animateTransform attributeName="transform" type="translate" values="0 0;0 24" begin="1.3s" dur="0.15s" fill="freeze"/>
        ${tetrisBlock(0, 9, "#a55eea")}
        <g transform="translate(0 -230)">${fall(0.2, 0.7)}${tetrisBlock(3, 9, "#ffd23f")}${tetrisBlock(4, 9, "#ffd23f")}</g>
      </g>
      <g transform="translate(0 -230)">${fall(1.45, 0.5)}${[0, 1, 2, 3].map((c) => tetrisBlock(c, 9, "#48dbfb")).join("")}</g>`,
  },
  // The little TV plays a cartoon: a smiley ball bouncing across a changing sky.
  cartoon: {
    front: `
      <clipPath id="rigTv"><rect x="70" y="199" width="114" height="105" rx="12"/></clipPath>
      <g clip-path="url(#rigTv)">
        <rect x="60" y="190" width="140" height="120" fill="#8fd3ff">
          <animate attributeName="fill" values="#8fd3ff;#ffd6e7;#c8f7c5;#8fd3ff" dur="2.4s" repeatCount="indefinite"/></rect>
        <ellipse cx="127" cy="318" rx="80" ry="26" fill="#7bd389"/>
        <g fill="#fff" opacity="0.9"><ellipse cx="0" cy="222" rx="14" ry="6"/><ellipse cx="10" cy="218" rx="9" ry="6"/>
          <animateTransform attributeName="transform" type="translate" values="80 0;200 0" dur="3s" repeatCount="indefinite"/></g>
        <g><g>
            <circle r="15" fill="#ffd23f" stroke="#4a3b2a" stroke-width="2.5"/>
            <circle cx="-5" cy="-3" r="2.2" fill="#4a3b2a"/><circle cx="5" cy="-3" r="2.2" fill="#4a3b2a"/>
            <path d="M-6 4 Q0 10 6 4" fill="none" stroke="#4a3b2a" stroke-width="2.2" stroke-linecap="round"/>
            <animateTransform attributeName="transform" type="scale" values="1.15 0.85;0.95 1.05;1.15 0.85" keyTimes="0;0.5;1" dur="0.6s" repeatCount="indefinite"/></g>
          <animateMotion path="M92 288 Q110 215 127 288 Q145 215 162 288 Q145 215 127 288 Q110 215 92 288" dur="2.4s" repeatCount="indefinite"/>
        </g>
      </g>`,
  },
  // Through the open window: sky, hills, a drifting cloud and birds flying past.
  lookfar: {
    back: `
      <clipPath id="rigWindow"><rect x="74" y="68" width="306" height="280"/></clipPath>
      <g clip-path="url(#rigWindow)">
        <rect x="74" y="68" width="306" height="280" fill="#bfe8ff"/>
        <g transform="translate(330 112)"><g>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line y1="-24" y2="-34" transform="rotate(${a})" stroke="#ffb703" stroke-width="4" stroke-linecap="round"/>`).join("")}${spin("6s")}</g>
          <circle r="18" fill="#ffd23f" stroke="#f4a100" stroke-width="3"/></g>
        <ellipse cx="140" cy="350" rx="130" ry="70" fill="#9ad27f"/><ellipse cx="320" cy="360" rx="150" ry="80" fill="#7bc46a"/>
        <g fill="#fff"><ellipse cx="0" cy="130" rx="26" ry="11"/><ellipse cx="16" cy="122" rx="16" ry="11"/>
          <animateTransform attributeName="transform" type="translate" values="120 0;300 0" dur="6s" repeatCount="indefinite"/></g>
        ${bird(84, 0, 2.2)}${bird(96, 0.5, 2.6)}${bird(78, 1.1, 2.4)}
      </g>`,
  },
};

// Illustrations are cached for a day; bump this when one is redrawn so devices fetch the new picture.
const ANIM_VERSION = 3;
const animSrc = (key) => `assets/anim/${key}.webp?v=${ANIM_VERSION}`;

// A task's animation: chosen in the editor (task.anim), otherwise matched from its name.
// "envelope" or no match plays the red envelope.
function themeFor(task) {
  if (task.anim) return THEMES[task.anim] ? task.anim : null;
  return Object.keys(THEMES).find((k) => THEMES[k].words.some((w) => task.name.includes(w))) || null;
}

// Groups on the kids' task list. A task goes into the group of its animation theme unless parents
// chose one for it (task.group); tasks with no group theme land in "其他".
const TASK_GROUPS = [
  { key: "clean", label: "🧼 洗漱卫生", themes: ["brush", "wash", "hair", "bath", "potty"] },
  { key: "life", label: "🍚 生活自理", themes: ["eat", "drink", "dress", "sleep", "tidy", "lookfar"] },
  { key: "kinder", label: "🏫 幼儿园和朋友", themes: ["kindergarten", "class", "chat"] },
  { key: "study", label: "📚 学习兴趣", themes: ["math", "homework", "read", "art", "guzheng", "music", "chess"] },
  { key: "sport", label: "🏃 运动户外", themes: ["sport", "bike", "outdoor", "hike", "park"] },
  { key: "play", label: "🎲 玩耍", themes: ["foosball", "boardgame", "tetris", "cartoon"] },
  { key: "other", label: "⭐ 其他", themes: [] },
];
const autoGroup = (task) => TASK_GROUPS.find((g) => g.themes.includes(themeFor(task)))?.key || "other";
const groupOf = (task) => (TASK_GROUPS.some((g) => g.key === task.group) ? task.group : autoGroup(task));

function celebrate(task) {
  const key = themeFor(task);
  if (!key) return redEnvelope(task.points, randomCheer());
  const theme = THEMES[key];
  document.querySelectorAll(".rp-overlay, .scene-overlay").forEach((o) => o.remove()); // quick taps: newest only
  const overlay = document.createElement("div");
  overlay.className = `scene-overlay theme-${key}`;
  const rig = RIGS[key] || {};
  const layer = (cls, svg) => (svg ? `<svg class="rig ${cls}" viewBox="${rig.box || "0 0 440 440"}" aria-hidden="true">${svg}</svg>` : "");
  // Shared fun for every theme: spinning sun rays behind the kid, a comic "哇！" sticker, and the
  // earned stars popping in one by one while the number counts up.
  const stars = "⭐".repeat(Math.min(task.points, 5));
  overlay.innerHTML = `
    <div class="scene">
      <div class="scene-art m-${theme.motion}">
        <div class="scene-rays"></div>
        ${layer("back", rig.back)}<img class="scene-kid" alt="" src="${animSrc(key)}" />${layer("front", rig.front)}
        <div class="scene-sticker"></div>
      </div>
      <div class="scene-label"><small></small><span class="scene-stars">${[...stars].map((s, i) => `<i style="animation-delay:${0.8 + i * 0.12}s">${s}</i>`).join("")}</span><b>+<span class="scene-num">0</span><span>⭐</span></b></div>
    </div>`;
  overlay.querySelector(".scene-label small").textContent = pick(theme.praise);
  overlay.querySelector(".scene-sticker").textContent = pick(["哇！", "耶！", "棒！", "酷！", "赞！", "好耶！"]);
  document.body.append(overlay);
  playSound(key);
  const kid = overlay.querySelector(".scene-kid");
  const r = kid.getBoundingClientRect(); // centered; the pop-in scale does not move the center
  theme.play({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: kid.offsetWidth });
  const num = overlay.querySelector(".scene-num");
  for (let i = 1; i <= task.points; i++) setTimeout(() => (num.textContent = i), 750 + (i * 500) / task.points);
  setTimeout(() => playSound("coins"), 850);
  setTimeout(() => flyStars(overlay.querySelector(".scene-label"), Math.min(task.points, 6)), 1700);
  setTimeout(() => overlay.classList.add("leave"), 2700);
  setTimeout(() => overlay.remove(), 3100);
}

// Warm the image cache so the first celebration shows its picture immediately.
function preloadThemes() {
  for (const key of Object.keys(THEMES)) new Image().src = animSrc(key);
}

/* ---------------- sounds (synthesized with Web Audio, no audio files) ---------------- */

const SOUND_KEY = "star-hero-sound";
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";
let audioCtx;
let noiseBuffer;

function audio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  // iOS reports "interrupted" rather than "suspended" after the page was in the background.
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  if (!noiseBuffer) {
    noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return audioCtx;
}

function tone(freq, start, dur, { type = "triangle", vol = 0.15, slideTo } = {}) {
  const ac = audioCtx;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function noise(start, dur, { vol = 0.3, filter = "lowpass", freq = 1000, freqTo, q = 1, attack = 0.005 } = {}) {
  const ac = audioCtx;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ac.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, start);
  if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, start + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(gain).connect(ac.destination);
  src.start(start, Math.random());
  src.stop(start + dur + 0.02);
}

const SOUNDS = {
  // "啵": a bubble popping — quick downward blip plus a tiny click.
  pop(t) {
    const f = rand(700, 1300);
    tone(f, t, 0.07, { type: "sine", vol: 0.22, slideTo: f * 0.35 });
    noise(t, 0.02, { vol: 0.05, filter: "highpass", freq: 4000 });
  },
  // Scrub-scrub of a toothbrush, then bubbly bloops rising.
  brush(t) {
    for (let i = 0; i < 6; i++) noise(t + i * 0.09, 0.07, { vol: 0.08, filter: "bandpass", freq: i % 2 ? 3200 : 2400, q: 3, attack: 0.02 });
    for (let i = 0; i < 4; i++) tone(rand(350, 500), t + 0.55 + i * 0.09, 0.12, { type: "sine", vol: 0.14, slideTo: rand(900, 1300) });
  },
  // "啊呜啊呜": two chomps, a crunch, then a happy "mmm".
  eat(t) {
    [0, 0.22].forEach((d) => {
      tone(330, t + d, 0.14, { type: "triangle", vol: 0.16, slideTo: 170 });
      noise(t + d + 0.05, 0.06, { vol: 0.06, filter: "bandpass", freq: 1800, q: 2 });
    });
    tone(392, t + 0.5, 0.25, { type: "sine", vol: 0.12, slideTo: 523 });
  },
  // Two page flips, then a magical chime.
  read(t) {
    [0, 0.18].forEach((d) => noise(t + d, 0.16, { vol: 0.12, filter: "highpass", freq: 1500, freqTo: 5000, attack: 0.04 }));
    [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + 0.38 + i * 0.08, 0.35, { type: "sine", vol: 0.1 }));
  },
  // Pencil scribbles, then "ding ding" for a perfect score.
  homework(t) {
    for (let i = 0; i < 5; i++) noise(t + i * 0.07, 0.05, { vol: 0.07, filter: "bandpass", freq: rand(2500, 4000), q: 4 });
    tone(1568, t + 0.42, 0.3, { type: "sine", vol: 0.13 });
    tone(2093, t + 0.56, 0.45, { type: "sine", vol: 0.13 });
  },
  // Boing-boing-boing of jumping rope, with a whoosh of the rope.
  sport(t) {
    for (let i = 0; i < 3; i++) {
      tone(140, t + i * 0.24, 0.2, { type: "sine", vol: 0.22, slideTo: 620 });
      noise(t + i * 0.24 + 0.1, 0.12, { vol: 0.05, filter: "bandpass", freq: 900, freqTo: 2400, q: 2, attack: 0.05 });
    }
  },
  // Rising sparkle glissando.
  tidy(t) {
    [1047, 1175, 1319, 1568, 1760, 2093, 2349, 2637].forEach((f, i) => tone(f, t + i * 0.05, 0.25, { type: "sine", vol: 0.12 }));
  },
  // Whoosh of putting clothes on, then "ta-da!".
  dress(t) {
    noise(t, 0.3, { vol: 0.1, filter: "bandpass", freq: 500, freqTo: 3000, q: 1.5, attack: 0.12 });
    tone(523, t + 0.32, 0.15, { vol: 0.14 });
    [659, 784, 1047].forEach((f) => tone(f, t + 0.48, 0.5, { vol: 0.1 }));
  },
  // Bouncy playground xylophone tune with giggly trills.
  kindergarten(t) {
    [523, 659, 784, 1047, 784, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.11, 0.18, { vol: 0.14 }));
    for (let i = 0; i < 3; i++) {
      tone(1400, t + 0.95 + i * 0.12, 0.08, { type: "sine", vol: 0.08, slideTo: 1900 });
      tone(1900, t + 1.01 + i * 0.12, 0.06, { type: "sine", vol: 0.06, slideTo: 1500 });
    }
  },
  // School bell "叮铃铃", then a cheerful two-note "到！".
  class(t) {
    for (let i = 0; i < 14; i++) tone(i % 2 ? 2093 : 2637, t + i * 0.04, 0.06, { type: "square", vol: 0.05 });
    tone(784, t + 0.7, 0.2, { vol: 0.16 });
    tone(1047, t + 0.86, 0.4, { vol: 0.16 });
  },
  // Counting up "1, 2, 3" on a xylophone, then a bright "ding!" for the right answer.
  math(t) {
    [523, 659, 784].forEach((f, i) => tone(f, t + i * 0.16, 0.18, { vol: 0.15 }));
    tone(1047, t + 0.52, 0.45, { type: "sine", vol: 0.14 });
    tone(1568, t + 0.6, 0.5, { type: "sine", vol: 0.08 });
  },
  // "咕咚咕咚": three gulps, then little water drips.
  drink(t) {
    for (let i = 0; i < 3; i++) {
      tone(520, t + i * 0.24, 0.15, { type: "sine", vol: 0.22, slideTo: 170 });
      noise(t + i * 0.24 + 0.03, 0.05, { vol: 0.05, filter: "lowpass", freq: 600 });
    }
    [1600, 2200, 1900].forEach((f, i) => tone(f, t + 0.8 + i * 0.13, 0.1, { type: "sine", vol: 0.1, slideTo: f * 1.6 }));
  },
  // Victory fanfare: "ta-ta-ta-taaa!".
  challenge(t) {
    [[523, 0, 0.12], [523, 0.14, 0.12], [523, 0.28, 0.12], [698, 0.42, 0.55]].forEach(([f, d, len]) => {
      tone(f, t + d, len, { type: "square", vol: 0.07 });
      tone(f * 2, t + d, len, { vol: 0.08 });
    });
    [880, 1047].forEach((f, i) => tone(f, t + 1 + i * 0.16, 0.5, { vol: 0.12 }));
  },
  // Running tap water, then a squeaky-clean sparkle.
  wash(t) {
    noise(t, 1, { vol: 0.12, filter: "bandpass", freq: 1500, q: 0.7, attack: 0.1 });
    [1568, 1760, 2093, 2637].forEach((f, i) => tone(f, t + 1 + i * 0.06, 0.22, { type: "sine", vol: 0.1 }));
  },
  // "哗——" water pours from the cup, bubbles bloop up, then a clean sparkle.
  hair(t) {
    noise(t, 0.9, { vol: 0.22, filter: "bandpass", freq: 800, freqTo: 2400, q: 0.6, attack: 0.08 });
    [0.95, 1.1, 1.22].forEach((d, i) => tone(500 + i * 180, t + d, 0.1, { type: "sine", vol: 0.14, slideTo: 1200 + i * 200 }));
    [1568, 2093, 2637].forEach((f, i) => tone(f, t + 1.4 + i * 0.07, 0.25, { type: "sine", vol: 0.09 }));
  },
  // A splash, then the rubber duck squeaks twice.
  bath(t) {
    noise(t, 0.45, { vol: 0.3, filter: "lowpass", freq: 2500, freqTo: 400 });
    [0.5, 0.75].forEach((d) => tone(900, t + d, 0.14, { type: "square", vol: 0.06, slideTo: 1300 }));
  },
  // "哗啦啦" flush, then a happy "叮咚叮".
  potty(t) {
    noise(t, 1.3, { vol: 0.25, filter: "lowpass", freq: 4000, freqTo: 250, attack: 0.15 });
    [784, 988, 1175].forEach((f, i) => tone(f, t + 1.15 + i * 0.13, 0.3, { vol: 0.14 }));
  },
  // Birds chirping over a light melody.
  outdoor(t) {
    for (let i = 0; i < 6; i++) {
      const f = rand(2600, 3400);
      tone(f, t + i * 0.11 + (i > 2 ? 0.3 : 0), 0.07, { type: "sine", vol: 0.07, slideTo: f * 1.3 });
    }
    [659, 784, 880, 1047].forEach((f, i) => tone(f, t + 0.2 + i * 0.18, 0.3, { vol: 0.1 }));
  },
  // Footsteps crunching uphill, then a "嘿～" that echoes back from the mountains.
  hike(t) {
    for (let i = 0; i < 4; i++) noise(t + i * 0.18, 0.08, { vol: 0.12, filter: "lowpass", freq: 900 });
    [0, 0.35, 0.7].forEach((d, i) => tone(523, t + 0.8 + d, 0.3, { vol: 0.15 / (i + 1), slideTo: 784 }));
  },
  // Wind whooshing as the kite rises, then a cheerful little tune.
  park(t) {
    noise(t, 1.2, { vol: 0.1, filter: "bandpass", freq: 400, freqTo: 1600, q: 1.2, attack: 0.4 });
    [784, 880, 988, 1175, 1568].forEach((f, i) => tone(f, t + 0.4 + i * 0.12, 0.25, { vol: 0.11 }));
  },
  // A family chat: the kid chatters in a high voice, mom and dad answer lower, then everyone giggles.
  chat(t) {
    const syllables = (start, n, lo, hi, vol) => {
      for (let i = 0; i < n; i++) {
        const f = rand(lo, hi);
        tone(f, start + i * 0.1, 0.08, { type: "sine", vol, slideTo: f * (i % 2 ? 0.75 : 1.35) });
      }
    };
    syllables(t, 5, 450, 650, 0.14); // kid
    syllables(t + 0.6, 3, 300, 400, 0.12); // mom
    syllables(t + 0.95, 3, 150, 220, 0.16); // dad
    for (let i = 0; i < 4; i++) tone(1100 - i * 80, t + 1.35 + i * 0.07, 0.06, { type: "sine", vol: 0.09, slideTo: 1500 - i * 80 });
  },
  // A TV "bloop" switching on, a boing-boing cartoon, then a giggle.
  cartoon(t) {
    tone(1800, t, 0.12, { type: "sine", vol: 0.08, slideTo: 300 });
    [0.25, 0.55].forEach((d) => tone(220, t + d, 0.22, { type: "sine", vol: 0.2, slideTo: 700 }));
    for (let i = 0; i < 4; i++) tone(1200 - i * 90, t + 0.95 + i * 0.08, 0.07, { type: "sine", vol: 0.09, slideTo: 1600 - i * 90 });
  },
  // A falling-blocks tune (the folk melody 货郎/Korobeiniki), then the line-clear "pling".
  tetris(t) {
    [[659, 0.2], [494, 0.1], [523, 0.1], [587, 0.2], [523, 0.1], [494, 0.1], [440, 0.2]].reduce((d, [f, len]) => {
      tone(f, t + d, len * 0.9, { type: "square", vol: 0.06 });
      return d + len;
    }, 0);
    [1319, 1760, 2637].forEach((f, i) => tone(f, t + 1.05 + i * 0.05, 0.25, { type: "sine", vol: 0.1 }));
  },
  // Birdsong and a soft breeze while the eyes rest.
  lookfar(t) {
    noise(t, 1.4, { vol: 0.05, filter: "bandpass", freq: 500, freqTo: 900, q: 0.8, attack: 0.5 });
    [0.1, 0.3, 0.75, 0.9].forEach((d) => {
      const f = rand(2800, 3600);
      tone(f, t + d, 0.09, { type: "sine", vol: 0.08, slideTo: f * 1.25 });
      tone(f * 1.1, t + d + 0.1, 0.07, { type: "sine", vol: 0.06, slideTo: f * 0.9 });
    });
  },
  // Two brush swishes, then a colorful "ta-da" glissando.
  art(t) {
    [0, 0.25].forEach((d) => noise(t + d, 0.22, { vol: 0.1, filter: "bandpass", freq: 1200, freqTo: 3500, q: 2, attack: 0.08 }));
    [523, 659, 784, 988, 1175, 1568].forEach((f, i) => tone(f, t + 0.55 + i * 0.06, 0.3, { type: "sine", vol: 0.1 }));
  },
  // A guzheng glissando sweeping up the pentatonic scale, then a plucked phrase.
  guzheng(t) {
    [587, 659, 740, 880, 988, 1175, 1319, 1480].forEach((f, i) => tone(f, t + i * 0.035, 0.6, { vol: 0.07 }));
    [880, 740, 988, 880].forEach((f, i) => tone(f, t + 0.5 + i * 0.2, 0.5, { vol: 0.13 }));
  },
  // "一闪一闪亮晶晶" on a music box.
  music(t) {
    [523, 523, 784, 784, 880, 880, 784].forEach((f, i) => tone(f, t + i * 0.17, i === 6 ? 0.45 : 0.2, { type: "sine", vol: 0.14 }));
  },
  // Dice rattling and rolling, then a win jingle.
  boardgame(t) {
    for (let i = 0; i < 7; i++) noise(t + i * 0.06 + rand(0, 0.03), 0.03, { vol: 0.16, filter: "highpass", freq: 2500 });
    [659, 784, 1047].forEach((f, i) => tone(f, t + 0.6 + i * 0.12, 0.3, { vol: 0.13 }));
  },
  // Go stones clacking on the board, then a bright "aha!".
  chess(t) {
    [0, 0.35, 0.6].forEach((d) => {
      noise(t + d, 0.03, { vol: 0.25, filter: "highpass", freq: 3000 });
      tone(1250, t + d, 0.06, { type: "sine", vol: 0.12 });
    });
    tone(1047, t + 0.95, 0.25, { type: "sine", vol: 0.12 });
    tone(1568, t + 1.08, 0.45, { type: "sine", vol: 0.12 });
  },
  // Bicycle bell "叮铃 叮铃", with a whoosh.
  bike(t) {
    [0, 0.3].forEach((d) => {
      tone(2200, t + d, 0.5, { type: "sine", vol: 0.12 });
      tone(3100, t + d, 0.4, { type: "sine", vol: 0.06 });
    });
    noise(t + 0.6, 0.5, { vol: 0.08, filter: "bandpass", freq: 600, freqTo: 2400, q: 1.5, attack: 0.2 });
  },
  // Clack-clack of the rods, the ball hits the goal, then the crowd cheers.
  foosball(t) {
    [0, 0.12, 0.3].forEach((d) => noise(t + d, 0.04, { vol: 0.2, filter: "highpass", freq: 1800 }));
    tone(180, t + 0.45, 0.2, { type: "sine", vol: 0.3, slideTo: 80 });
    noise(t + 0.55, 0.9, { vol: 0.15, filter: "bandpass", freq: 1000, q: 0.5, attack: 0.15 });
    [523, 659, 784, 1047].forEach((f, i) => tone(f, t + 0.6 + i * 0.1, 0.3, { vol: 0.12 }));
  },
  // The reward falls (whistle down), lands in the cart (thump), and the cart rings.
  drop(t) {
    tone(1400, t, 0.75, { type: "sine", vol: 0.1, slideTo: 300 });
    tone(150, t + 0.9, 0.18, { type: "sine", vol: 0.3, slideTo: 70 });
    noise(t + 0.9, 0.12, { vol: 0.15, filter: "lowpass", freq: 900 });
    tone(1319, t + 1.05, 0.25, { type: "sine", vol: 0.12 });
  },
  // Soft lullaby with a twinkle.
  sleep(t) {
    [659, 587, 523, 587, 659, 659, 659].forEach((f, i) => tone(f, t + i * 0.2, 0.32, { type: "sine", vol: 0.13 }));
    tone(2637, t + 1.5, 0.4, { type: "sine", vol: 0.04 });
  },
  // Bright two-note chime, like receiving a red packet.
  redPacket(t) {
    tone(1318, t, 0.18, { type: "sine", vol: 0.2 });
    tone(1976, t + 0.09, 0.5, { type: "sine", vol: 0.2 });
    tone(3951, t + 0.09, 0.35, { type: "sine", vol: 0.05 });
  },
  // Coins tumbling out when the envelope opens.
  coins(t) {
    tone(988, t, 0.08, { type: "square", vol: 0.1 });
    tone(1319, t + 0.08, 0.45, { type: "square", vol: 0.1 });
    for (let i = 0; i < 6; i++) tone(2600 + Math.random() * 2400, t + 0.12 + i * 0.06 + Math.random() * 0.03, 0.12, { type: "sine", vol: 0.09 });
  },
  // Whistling launch, boom, then crackles.
  firework(t) {
    noise(t, 1.05, { vol: 0.08, filter: "bandpass", freq: 600, freqTo: 3000, q: 8, attack: 0.4 });
    const boom = t + 1.1;
    noise(boom, 1.1, { vol: 0.5, filter: "lowpass", freq: 1800, freqTo: 120 });
    tone(110, boom, 0.5, { type: "sine", vol: 0.35, slideTo: 40 });
    for (let i = 0; i < 14; i++) noise(boom + 0.25 + Math.random() * 0.9, 0.03, { vol: 0.12 + Math.random() * 0.1, filter: "highpass", freq: 2500 + Math.random() * 3000 });
  },
  win(t) {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.35, { vol: 0.15 }));
    tone(1568, t + 0.48, 0.6, { type: "sine", vol: 0.08 });
  },
  ding(t) {
    tone(880, t, 0.25);
    tone(1320, t + 0.1, 0.3);
  },
  nope(t) {
    tone(220, t, 0.2, { type: "square", vol: 0.1 });
    tone(180, t + 0.12, 0.25, { type: "square", vol: 0.1 });
  },
};

// Phones stop the page's audio when it goes to the background or the screen locks, and iOS may never
// resume that context. So drop a stopped context when the page comes back, and start audio again on
// the next tap, so that sounds played later from timers (cart drop, coins, fireworks) are heard too.
function dropStoppedAudio() {
  if (document.visibilityState !== "visible" || !audioCtx || audioCtx.state === "running") return;
  audioCtx.close().catch(() => {});
  audioCtx = null;
  noiseBuffer = null;
}
document.addEventListener("visibilitychange", dropStoppedAudio);
addEventListener("pageshow", dropStoppedAudio);
for (const type of ["pointerup", "touchend", "keydown"]) {
  addEventListener(type, () => soundOn && audioCtx?.state !== "running" && audio(), { capture: true, passive: true });
}

function playSound(kind) {
  if (!soundOn) return;
  try {
    SOUNDS[kind](audio().currentTime + 0.01);
  } catch {}
}

function updateSoundBtn() {
  $("#soundBtn").textContent = soundOn ? "🔊" : "🔇";
  $("#soundBtn").title = soundOn ? "关闭声音" : "打开声音";
}

/* ---------------- login & family ---------------- */

let authMode = "login";

function showAuth(message = "") {
  $("#app").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  $("#authError").textContent = message;
}

async function enterApp(profile) {
  me = profile;
  members = [];
  parentUnlocked = false;
  newLockQuestion();
  state = structuredClone(DEFAULT_STATE); // never show the previous family's data, even briefly
  render();
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  showTab("tasks");
  try {
    await load();
  } catch {
    if (!me) return;
    toast("⚠️ 连不上服务器，数据暂时不会保存");
  }
  render();
}

async function start() {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (res.ok) return enterApp(await res.json());
    showAuth();
  } catch {
    showAuth("连不上服务器，请稍后再试");
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const f = $("#authForm");
  const register = mode === "register";
  document.querySelectorAll(".auth-tabs button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  f.classList.toggle("login", !register);
  f.familyName.required = register;
  f.role.required = register;
  f.password.autocomplete = register ? "new-password" : "current-password";
  $("#authSubmit").textContent = register ? "创建家庭并登录" : "登录";
  $("#authNote").textContent = register
    ? "创建后可以在「家长」里为妈妈、爷爷奶奶等家人添加账号"
    : "爸爸妈妈用自己的账号登录，看到的是同一个家庭的数据";
  $("#authError").textContent = "";
}

// Quick-pick buttons that fill a role input (爸爸, 妈妈, ...).
function bindRoleChips(form) {
  const input = form.querySelector(".role-input");
  const box = form.querySelector(".role-chips");
  const sync = () => box.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.textContent === input.value.trim()));
  for (const opt of $("#roleList").options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opt.value;
    b.addEventListener("click", () => {
      input.value = opt.value;
      sync();
    });
    box.append(b);
  }
  input.addEventListener("input", sync);
  form.addEventListener("reset", () => setTimeout(sync));
}

async function loadMembers() {
  try {
    const res = await api("/api/family");
    const family = await res.json();
    members = family.members;
    me.family.name = family.name;
    me.admin = !!members.find((m) => m.me)?.admin;
  } catch {}
  renderMembers();
}

function renderMembers() {
  $("#familyName").textContent = me.family.name;
  // Only the admin (the family's first account) can add or remove members.
  const admin = members.find((m) => m.admin);
  $("#addMemberForm").classList.toggle("hidden", !me.admin);
  $(".member-hint").textContent = me.admin
    ? "你是管理员，可以给家人添加账号。每个人用自己的账号登录，看到和管理的是同一份数据。"
    : `只有管理员${admin ? `（${admin.role} ${admin.username}）` : ""}可以添加或移除家庭成员。`;
  const ul = $("#memberList");
  ul.innerHTML = "";
  for (const m of members) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="e-role"></span><span class="e-name"></span>`;
    li.querySelector(".e-role").textContent = m.role;
    li.querySelector(".e-name").textContent = m.username;
    if (m.admin) li.querySelector(".e-name").insertAdjacentHTML("beforeend", ` <span class="e-admin">管理员</span>`);
    if (m.me) {
      li.insertAdjacentHTML("beforeend", `<span class="e-me">（我）</span>`);
    } else if (me.admin) {
      const del = document.createElement("button");
      del.className = "btn small danger";
      del.textContent = "移除";
      del.addEventListener("click", () =>
        confirmModal("👋", `移除「${m.role}」的账号？`, `${m.username} 将不能再登录这个家庭`, "移除", async () => {
          try {
            const res = await api(`/api/family/members/${encodeURIComponent(m.username)}`, { method: "DELETE" });
            if (!res.ok) throw new Error((await res.json()).error);
            toast("已移除");
          } catch (err) {
            toast(err.message);
          }
          loadMembers();
        }),
      );
      li.append(del);
    }
    ul.append(li);
  }
}

function bindAuth() {
  document.querySelectorAll(".auth-tabs button").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  bindRoleChips($("#authForm"));
  bindRoleChips($("#addMemberForm"));

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const creds = { username: f.username.value.trim(), password: f.password.value };
    const register = authMode === "register";
    $("#authSubmit").disabled = true;
    try {
      const res = await fetch(register ? "/api/families" : "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(register ? { ...creds, familyName: f.familyName.value.trim(), role: f.role.value.trim() } : creds),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      f.reset();
      setAuthMode("login");
      await enterApp(body);
    } catch (err) {
      $("#authError").textContent = err.message || "连不上服务器，请稍后再试";
    } finally {
      $("#authSubmit").disabled = false;
    }
  });

  $("#addMemberForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const res = await api("/api/family/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: f.role.value.trim(), username: f.username.value.trim(), password: f.password.value }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      infoModal("🎉", `已添加「${f.role.value.trim()}」`, `用户名 ${f.username.value.trim()}，用刚才设置的密码登录就能看到同一份数据`);
      f.reset();
      loadMembers();
    } catch (err) {
      toast(err.message || "添加失败，请稍后再试");
    }
  });

  $("#passwordBtn").addEventListener("click", () => {
    const f = $("#passwordForm");
    f.reset();
    $("#passwordError").textContent = "";
    $("#passwordAccount").textContent = `账号：${me.username}（${me.role}）`;
    openEditor("#passwordEditor");
  });

  $("#passwordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirmPassword.value) {
      $("#passwordError").textContent = "两次输入的新密码不一样";
      return;
    }
    try {
      const res = await api("/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword: f.oldPassword.value, newPassword: f.newPassword.value }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      closeEditors();
      infoModal("🔑", "密码已修改", "下次登录请用新密码。其他设备上的这个账号需要重新登录。");
    } catch (err) {
      $("#passwordError").textContent = err.message || "修改失败，请稍后再试";
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    if (saveTimer) await flushSave();
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    me = null;
    showAuth();
  });
}

/* ---------------- init ---------------- */

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
$("#avatarBtn").addEventListener("click", () => {
  state.avatar = AVATARS[(AVATARS.indexOf(state.avatar) + 1) % AVATARS.length];
  save();
  render();
});
$("#soundBtn").addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  updateSoundBtn();
  playSound("ding");
});
updateSoundBtn();
preloadThemes();
bindParent();
bindAuth();
start();

// Every 30s: sync changes from other family members, and re-render after midnight for a new day.
let lastDay = dateKey();
setInterval(() => {
  refresh();
  if (dateKey() !== lastDay) {
    lastDay = dateKey();
    render();
  }
}, 30000);
