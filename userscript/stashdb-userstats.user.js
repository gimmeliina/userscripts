// ==UserScript==
// @name        stashdb-userstats-ext
// @namespace   gimmelii.na
// @author      gimeliina
// @version     0.3.5
// @description Adds user stats to stashdb
// @match       https://stashdb.org/*
// @match       https://fansdb.cc/*
// @match       https://javstash.org/*
// @grant       GM.addStyle
// @require     https://feederbox.cc/uscript/requires/wfke.js
// @require     https://cdn.jsdelivr.net/npm/idb@8/build/umd.js
// ==/UserScript==

const editThreshold = (edit_ratio, total_edits) =>
  edit_ratio >= 0.99 && total_edits > 3500 ? "❇️"
  : edit_ratio > 0.9 ? "🟩"
  : edit_ratio > 0.8 ? "🟨"
  : edit_ratio > 0.5 ? "🟧"
  : edit_ratio === 0 ? "❓"
  : "🟥"

// OPTIMIZATION: Memoize threshold calculations
const thresholdCache = new Map();
const roundThreshold = (number) => {
  if (thresholdCache.has(number)) return thresholdCache.get(number);
  
  let result;
  if (number == 0) result = "0";
  else if (number < 10) result = "<10";
  else {
    const thresholds = [25000, 20000, 15000, 10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000, 500, 100, 50, 10];
    for (const threshold of thresholds) {
      if (number >= threshold && threshold >= 1000) {
        result = `${threshold * 0.001}k`;
        break;
      }
      else if (number >= threshold) {
        result = `${threshold}`;
        break;
      }
    }
  }
  
  thresholdCache.set(number, result);
  return result;
}

// clear cache if version mismatch
const CACHEVERSION = 2;
const DEBUG_SKIP_CACHE = false;

GM.addStyle(`
  .user-card {
    padding-left: 1ch;
    white-space: pre;
    cursor: pointer;
  }
`);

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// OPTIMIZATION: Persistent DB connection
let dbInstance = null;
const getDBInstance = async () => {
  if (!dbInstance) {
    dbInstance = await idb.openDB("stashdb-userstats", 2, {
      upgrade(db, oldver, newver) {
        if (oldver < 1) {
          db.createObjectStore("users", { keyPath: "username" });
          db.createObjectStore("config");
        } else if (newver === 2) {
          db.createObjectStore("config");
        }
      },
    });
  }
  return dbInstance;
};

const callGQL = async (query, variables = {}) => {
  try {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    const json = await response.json();
    if (json.errors) {
      console.error("GraphQL Error:", json.errors);
      throw new Error(json.errors[0]?.message || "Unknown GraphQL error");
    }
    return json.data;
  } catch (error) {
    console.error("API call failed:", error);
    throw error;
  }
}

class User {
  constructor(user, edit, opStats, typeStats) {
    this.id = user.id;
    this.last_update = new Date();
    this.edit_accept =
      user.edit_count.accepted + user.edit_count.immediate_accepted;
    this.edit_reject =
      user.edit_count.rejected +
      user.edit_count.immediate_rejected;
    this.edit_pending = user.edit_count.pending;
    this.edit_cancel = user.edit_count.canceled
    this.edit_first = edit.edits.length
      ? new Date(edit.edits?.[0]?.closed)
      : false;
    this.vote_abstain = user.vote_count.abstain;
    this.vote_accept =
      user.vote_count.accept + user.vote_count.immediate_accept;
    this.vote_reject =
      user.vote_count.reject + user.vote_count.immediate_reject;
    this.vote_total = this.vote_abstain + this.vote_accept + this.vote_reject;
    this.total_edits = this.edit_accept + this.edit_reject;
    this.edit_ratio = this.total_edits > 0 ? this.edit_accept / this.total_edits : 0;
    this.user_new = this.edit_first
      ? Date.now() - this.edit_first < MONTH
      : true;
    this.operation_stats = {
      create: opStats[0],
      modify: opStats[1],
      destroy: opStats[2],
      merge: opStats[3],
    }
    this.type_stats = {
      scene: typeStats[0],
      studio: typeStats[1],
      performer: typeStats[2],
      tag: typeStats[3],
    }
    this._summaryCache = null;
  }
}
let paginationObserved = false;

const getUser = async (username) => {
  try {
    const db = await getDBInstance();
    const dbUser = await db.get("users", username);
    if (dbUser && !DEBUG_SKIP_CACHE) {
      if (Date.now() - dbUser.last_update < (DAY * 1.5)) return dbUser;
    }
    
    const user = await fetchUser(username);
    const [firstEdit, userOpStats, userTypeStats] = await Promise.all([
      fetchFirstEdit(user.findUser.id),
      fetchAllOpStats(user.findUser.id),
      fetchAllTypeStats(user.findUser.id)
    ]);
    const liveUser = new User(user.findUser, firstEdit.queryEdits, userOpStats, userTypeStats);
    await cacheUser(username, liveUser);
    return liveUser;
  } catch (error) {
    console.error(`Failed to fetch user ${username}:`, error);
    return null;
  }
};

const fetchUser = (username) => {
  const query = `query ($username: String) {
    findUser(username: $username) {
    id
    edit_count {
        accepted immediate_accepted
        rejected immediate_rejected
        canceled
        pending
    } vote_count {
        abstain
        accept immediate_accept
        reject immediate_reject
    }}}`
  const variables = { username }
  return callGQL(query, variables)
}

const fetchFirstEdit = (user_id) => {
  const query = `query ($user_id: ID) {
    queryEdits(
    input: {
      user_id: $user_id
      status: ACCEPTED page: 1 per_page: 1
      sort: CLOSED_AT direction: ASC
    }) {
      edits { closed }}}`
  const variables = { user_id }
  return callGQL(query, variables)
}

// OPTIMIZATION: Batch all stats into single query
const fetchAllStats = (user_id) => {
  const query = `query ($user_id: ID) {
    createStats: queryEdits(input: {user_id: $user_id, operation: CREATE}) { count }
    modifyStats: queryEdits(input: {user_id: $user_id, operation: MODIFY}) { count }
    destroyStats: queryEdits(input: {user_id: $user_id, operation: DESTROY}) { count }
    mergeStats: queryEdits(input: {user_id: $user_id, operation: MERGE}) { count }
    sceneStats: queryEdits(input: {user_id: $user_id, target_type: SCENE}) { count }
    studioStats: queryEdits(input: {user_id: $user_id, target_type: STUDIO}) { count }
    performerStats: queryEdits(input: {user_id: $user_id, target_type: PERFORMER}) { count }
    tagStats: queryEdits(input: {user_id: $user_id, target_type: TAG}) { count }
  }`
  const variables = { user_id }
  return callGQL(query, variables)
}

const fetchAllOpStats = async (user_id) => {
  try {
    const batchResult = await fetchAllStats(user_id);
    return [
      batchResult.createStats.count,
      batchResult.modifyStats.count,
      batchResult.destroyStats.count,
      batchResult.mergeStats.count,
    ];
  } catch (e) {
    console.warn("Batch stats failed:", e);
    return [0, 0, 0, 0];
  }
};

const fetchAllTypeStats = async (user_id) => {
  try {
    const batchResult = await fetchAllStats(user_id);
    return [
      batchResult.sceneStats.count,
      batchResult.studioStats.count,
      batchResult.performerStats.count,
      batchResult.tagStats.count,
    ];
  } catch (e) {
    console.warn("Batch stats failed:", e);
    return [0, 0, 0, 0];
  }
};

const editPercentage = (num, total) => total > 0 ? `${Math.floor(num/total*100)}%` : "0%";

const cacheUser = async (username, data) => {
  try {
    const db = await getDBInstance();
    await db.put("users", { username, ...data });
  } catch (error) {
    console.error("Cache write failed:", error);
  }
};

// OPTIMIZATION: Lazy load summary only on demand
const generateUserSummary = (user) => {
  if (user._summaryCache) return user._summaryCache;
  
  user._summaryCache = `
edits:
  accepted: ${user.edit_accept}
  rejected: ${user.edit_reject}
  pending: ${user.edit_pending}
  cancelled: ${user.edit_cancel}
  first edit: ${user.edit_first ? user.edit_first.toDateString() : "none"}
votes:
  total: ${user.vote_total}
  accept: ${user.vote_accept}
  reject: ${user.vote_reject}
  abstain: ${user.vote_abstain}
operations:
  create: ${user.operation_stats.create} (${editPercentage(user.operation_stats.create, user.total_edits)})
  modify: ${user.operation_stats.modify} (${editPercentage(user.operation_stats.modify, user.total_edits)})
  destroy: ${user.operation_stats.destroy} (${editPercentage(user.operation_stats.destroy, user.total_edits)})
  merge: ${user.operation_stats.merge} (${editPercentage(user.operation_stats.merge, user.total_edits)})
types:
  scene: ${user.type_stats.scene} (${editPercentage(user.type_stats.scene, user.total_edits)})
  studio: ${user.type_stats.studio} (${editPercentage(user.type_stats.studio, user.total_edits)})
  performer: ${user.type_stats.performer} (${editPercentage(user.type_stats.performer, user.total_edits)})
  tag: ${user.type_stats.tag} (${editPercentage(user.type_stats.tag, user.total_edits)})
`;
  return user._summaryCache;
};

const generateUserCard = (user) => {
  if (!user) {
    const card = document.createElement("span");
    card.classList.add("user-card");
    card.textContent = "❌";
    card.title = "Failed to load user stats";
    return card;
  }
  
  const card = document.createElement("span");
  card.classList.add("user-card");
  
  if (user.edit_pending > 10) {
    const pendingElem = document.createElement("span");
    pendingElem.textContent = "⌛";
    pendingElem.title = `${user.edit_pending} pending edits`;
    card.append(pendingElem);
  }
  
  if (user.user_new) {
    card.textContent = "🌱";
    return card;
  }
  
  const voteElem = document.createElement("span");
  voteElem.textContent = "🗳️"
  voteElem.title = `${user.vote_accept} 👍\n${user.vote_reject} 👎\n${user.vote_abstain} 🤷`;
  
  const editElem = document.createElement("span");
  editElem.textContent = `${editThreshold(user.edit_ratio, user.total_edits)}${roundThreshold(user.edit_accept)}`;
  editElem.title = `${Math.floor(user.edit_ratio * 100)}%\n${user.edit_accept} ✅\n${user.edit_reject} ❌\n${user.edit_cancel} 🗑️`;
  
  const opElem = document.createElement("span");
  opElem.textContent = "🔨";
  opElem.title = `${user.operation_stats.create} ✨\n${user.operation_stats.modify} 🛠️\n${user.operation_stats.destroy} 🗑️\n${user.operation_stats.merge} 🔗`;
  
  const targetElem = document.createElement("span");
  targetElem.textContent = "🎯"
  targetElem.title = `${user.type_stats.scene} 🎞️\n${user.type_stats.studio} 🎬\n${user.type_stats.performer} 🎭\n${user.type_stats.tag} 🏷️`;
  
  card.append(voteElem, editElem, opElem, targetElem);
  const originalHTML = card.innerHTML;
  
  card.addEventListener("click", (evt) => {
    evt.preventDefault()
    const expanded = card.dataset.expanded === "1";
    if (!expanded) {
      card.dataset.expanded = "1";
      card.textContent = generateUserSummary(user);
    } else {
      card.dataset.expanded = "0";
      card.innerHTML = originalHTML;
    }
  });
  
  return card;
};

// OPTIMIZATION: Debounce rapid setupPage calls
let setupTimeout;
const debouncedSetupPage = () => {
  clearTimeout(setupTimeout);
  setupTimeout = setTimeout(setupPage, 100);
};

async function setupPage() {
  const users = Array.from(
    document.querySelectorAll('.EditCard a[href^="/users"]')
  );
  
  if (users.length === 0) return;
  
  // Extract unique usernames
  const usernames = new Set(users.map(userElem => userElem.textContent));
  
  // Prefetch all users in parallel
  await Promise.all(Array.from(usernames).map(username => getUser(username)));
  
  // Render cards
  users.forEach((userElem) => {
    // Skip if already has usercard
    if (userElem.nextElementSibling?.classList?.contains("user-card")) return;
    
    const username = userElem.href.split("/").pop();
    getUser(username).then((userData) => {
      // Double check card wasn't already added
      if (userElem.nextElementSibling?.classList?.contains("user-card")) return;
      
      const userCard = generateUserCard(userData);
      userElem.insertAdjacentElement("afterend", userCard);
      if (userData) {
        userElem.title = generateUserSummary(userData);
      }
    });
  });
}

async function checkCacheVersion() {
  try {
    const db = await getDBInstance();
    const cacheVersion = await db.get("config", "cacheversion");
    if (cacheVersion !== CACHEVERSION) {
      await db.clear("users");
      await db.put("config", CACHEVERSION, "cacheversion");
    }
  } catch (error) {
    console.error("Cache version check failed:", error);
  }
}

checkCacheVersion()

async function runPage() {
  wfke(".EditCard", () => debouncedSetupPage());
  wfke("ul.pagination", observePagination);
}

function observePagination() {
  if (paginationObserved) return;
  const paginationEl = document.querySelector("ul.pagination");
  if (!paginationEl) return;
  
  new MutationObserver(() => runPage()).observe(paginationEl, {
    attributes: true,
    subtree: true,
  });
  paginationObserved = true;
}

// navigation observer
new MutationObserver(() => runPage()).observe(document.querySelector("title"), {
  childList: true,
});

runPage();
