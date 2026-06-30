const API_BASE = "/api";
const POLL_INTERVAL_MS = 3500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_MS = 28 * DAY_MS;
const EXTENSION_WINDOW_MS = 7 * DAY_MS;

const elements = {
  syncStatus: document.querySelector("#syncStatus"),
  toast: document.querySelector("#toast"),
  eventForm: document.querySelector("#eventForm"),
  expiryDate: document.querySelector("#expiryDate"),
  extendButton: document.querySelector("#extendButton"),
  eventTitle: document.querySelector("#eventTitle"),
  eventCurrency: document.querySelector("#eventCurrency"),
  participantForm: document.querySelector("#participantForm"),
  participantName: document.querySelector("#participantName"),
  participantCount: document.querySelector("#participantCount"),
  participantList: document.querySelector("#participantList"),
  expenseForm: document.querySelector("#expenseForm"),
  expenseTitle: document.querySelector("#expenseTitle"),
  expenseAmount: document.querySelector("#expenseAmount"),
  expensePayer: document.querySelector("#expensePayer"),
  splitAll: document.querySelector("#splitAll"),
  splitList: document.querySelector("#splitList"),
  expenseList: document.querySelector("#expenseList"),
  totalAmount: document.querySelector("#totalAmount"),
  summaryGrid: document.querySelector("#summaryGrid"),
  settlementCount: document.querySelector("#settlementCount"),
  settlementList: document.querySelector("#settlementList"),
};

let state = createEmptyState();
let saveTimer = 0;
let pollTimer = 0;
let toastTimer = 0;
let isSaving = false;
let isPolling = false;
let lastSyncedAt = 0;

bindEvents();
render();
void boot();

async function boot() {
  const groupId = getGroupIdFromUrl();

  try {
    if (groupId) {
      await loadGroup(groupId);
    } else {
      await createNewGroup({ askConfirmation: false });
    }

    startPolling();
  } catch (error) {
    console.error(error);
    if (error.status === 410) {
      showExpired(error.message);
      return;
    }
    setSyncStatus("Fehler", "error", "Runde konnte nicht geladen werden.");
    showToast("Runde konnte nicht geladen werden.");
  }
}

function bindEvents() {
  elements.eventForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.title = elements.eventTitle.value.trim() || "Abend";
    state.currency = sanitizeCurrency(elements.eventCurrency.value);
    persist();
    showToast("Gespeichert.");
  });

  elements.participantForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = elements.participantName.value.trim();
    if (!name) {
      showToast("Bitte einen Namen eintragen.");
      return;
    }

    const id = makeId("p");
    state.participants[id] = { id, name, createdAt: Date.now() };
    elements.participantName.value = "";
    persist();
  });

  elements.expenseForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const people = getParticipants();
    if (people.length === 0) {
      showToast("Bitte zuerst Personen hinzufügen.");
      return;
    }

    const payerId = elements.expensePayer.value;
    if (!state.participants[payerId]) {
      showToast("Bitte auswählen, wer bezahlt hat.");
      return;
    }

    const amountCents = parseMoneyInput(elements.expenseAmount.value);
    if (!amountCents) {
      showToast("Bitte einen gültigen Betrag eintragen.");
      return;
    }

    const selectedParticipants = elements.splitAll.checked
      ? people.map((person) => person.id)
      : Array.from(elements.splitList.querySelectorAll("input:checked")).map((input) => input.value);

    if (selectedParticipants.length === 0) {
      showToast("Bitte mindestens eine Person auswählen.");
      return;
    }

    const id = makeId("e");
    state.expenses[id] = {
      id,
      title: elements.expenseTitle.value.trim() || "Ausgabe",
      amountCents,
      payerId,
      participantIds: selectedParticipants,
      createdAt: Date.now(),
    };

    elements.expenseForm.reset();
    elements.splitAll.checked = true;
    persist();
  });

  elements.splitAll.addEventListener("change", renderSplitList);

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const { action, id } = button.dataset;

    if (action === "copy-link") {
      await copyShareLink();
    }

    if (action === "new-group") {
      await createNewGroup({ askConfirmation: true });
    }

    if (action === "extend-group") {
      await extendGroup();
    }

    if (action === "rename-person") {
      renameParticipant(id);
    }

    if (action === "delete-person") {
      deleteParticipant(id);
    }

    if (action === "delete-expense") {
      deleteExpense(id);
    }
  });
}

async function loadGroup(groupId) {
  setSyncStatus("Lädt", "cloud", "Runde wird geladen.");
  const response = await fetchJson(`${API_BASE}/groups/${encodeURIComponent(groupId)}`);
  state = normalizeState(response.state);
  lastSyncedAt = Number(state.updatedAt) || 0;
  setGroupUrl(state.id);
  setSyncStatus("Bereit", "cloud", "Alle mit Link können bearbeiten.");
  render();
}

async function createNewGroup({ askConfirmation }) {
  const hasContent = getParticipants().length > 0 || getExpenses().length > 0;
  if (askConfirmation && hasContent && !window.confirm("Aktuelle Runde verlassen und eine neue starten?")) {
    return;
  }

  stopPolling();
  setSyncStatus("Erstellt", "cloud", "Neue Runde wird erstellt.");
  const response = await fetchJson(`${API_BASE}/groups`, {
    method: "POST",
    body: JSON.stringify({ state: createEmptyState() }),
  });

  state = normalizeState(response.state);
  lastSyncedAt = Number(state.updatedAt) || 0;
  setGroupUrl(state.id);
  render();
  setSyncStatus("Bereit", "cloud", "Alle mit Link können bearbeiten.");
  showToast("Neue Runde erstellt.");
  startPolling();
}

async function extendGroup() {
  if (!canExtendCurrentGroup()) {
    showToast("Der Link kann erst innerhalb der letzten 7 Tage verlängert werden.");
    return;
  }

  try {
    setSyncStatus("Verlängert", "cloud", "Ablaufdatum wird verlängert.");
    const response = await fetchJson(`${API_BASE}/groups/${encodeURIComponent(state.id)}/extend`, {
      method: "POST",
    });
    state = normalizeState(response.state);
    lastSyncedAt = Number(state.updatedAt) || 0;
    render();
    setSyncStatus("Bereit", "cloud", "Alle mit Link können bearbeiten.");
    showToast("Link um eine Woche verlängert.");
  } catch (error) {
    if (error.status === 410) {
      showExpired(error.message);
      return;
    }
    setSyncStatus("Fehler", "error", "Verlängern ist fehlgeschlagen.");
    showToast(error.message || "Verlängern ist fehlgeschlagen.");
  }
}

function renameParticipant(id) {
  const person = state.participants[id];
  if (!person) return;

  const name = window.prompt("Neuer Name", person.name)?.trim();
  if (!name || name === person.name) return;

  state.participants[id] = { ...person, name };
  persist();
}

function deleteParticipant(id) {
  const isUsed = getExpenses().some(
    (expense) => expense.payerId === id || expense.participantIds.includes(id),
  );

  if (isUsed) {
    showToast("Person ist in Ausgaben enthalten.");
    return;
  }

  delete state.participants[id];
  persist();
}

function deleteExpense(id) {
  if (!state.expenses[id]) return;
  delete state.expenses[id];
  persist();
}

async function copyShareLink() {
  const link = buildGroupLink(state.id);

  try {
    await navigator.clipboard.writeText(link);
    showToast("Link kopiert.");
  } catch {
    window.prompt("Link kopieren", link);
  }
}

function persist() {
  state.updatedAt = Date.now();
  render();
  scheduleSave();
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveGroup();
  }, 250);
}

async function saveGroup() {
  if (!state.id) return;

  isSaving = true;
  setSyncStatus("Speichert", "cloud", "Änderungen werden gespeichert.");

  try {
    const response = await fetchJson(`${API_BASE}/groups/${encodeURIComponent(state.id)}`, {
      method: "PUT",
      body: JSON.stringify({ state }),
    });
    state = normalizeState(response.state);
    lastSyncedAt = Number(state.updatedAt) || 0;
    setSyncStatus("Gespeichert", "cloud", "Alle mit Link können bearbeiten.");
    render();
  } catch (error) {
    console.error(error);
    if (error.status === 410) {
      showExpired(error.message);
      return;
    }
    setSyncStatus("Fehler", "error", "Speichern ist fehlgeschlagen.");
    showToast("Speichern ist fehlgeschlagen.");
  } finally {
    isSaving = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void pollGroup();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
  pollTimer = 0;
}

async function pollGroup() {
  if (!state.id || isSaving || isPolling) return;
  isPolling = true;

  try {
    const response = await fetchJson(`${API_BASE}/groups/${encodeURIComponent(state.id)}`);
    const remoteState = normalizeState(response.state);
    const remoteUpdatedAt = Number(remoteState.updatedAt) || 0;

    if (remoteUpdatedAt > lastSyncedAt && remoteUpdatedAt > Number(state.updatedAt || 0)) {
      state = remoteState;
      lastSyncedAt = remoteUpdatedAt;
      render();
      setSyncStatus("Aktualisiert", "cloud", "Änderungen vom Link wurden geladen.");
    }
  } catch (error) {
    if (error.status === 410) {
      showExpired(error.message);
      return;
    }
    setSyncStatus("Fehler", "error", "Aktualisieren ist fehlgeschlagen.");
  } finally {
    isPolling = false;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return body;
}

function render() {
  const people = getParticipants();
  const expenses = getExpenses();
  const result = calculateResult();

  setFieldValue(elements.eventTitle, state.title);
  setFieldValue(elements.eventCurrency, state.currency);

  elements.participantCount.textContent = String(people.length);
  elements.totalAmount.textContent = formatMoney(result.totalCents);
  elements.settlementCount.textContent = String(result.settlements.length);

  renderExpiry();
  renderParticipants(people, result);
  renderPayerSelect(people);
  renderSplitList();
  renderExpenses(expenses);
  renderSummary(result);
  renderSettlements(result);
}

function renderExpiry() {
  const expiresAt = Number(state.expiresAt || 0);
  const remainingMs = expiresAt - Date.now();
  const isExpired = Boolean(expiresAt) && remainingMs <= 0;
  const isNearExpiry = !isExpired && remainingMs <= EXTENSION_WINDOW_MS;

  elements.expiryDate.classList.toggle("warning", isNearExpiry);
  elements.expiryDate.classList.toggle("expired", isExpired);
  elements.expiryDate.textContent = expiresAt ? `Ablauf: ${formatDateTime(expiresAt)}` : "Ablauf: -";
  elements.expiryDate.title = isNearExpiry
    ? "Dieser Link kann jetzt um eine Woche verlängert werden."
    : "Links können innerhalb der letzten 7 Tage verlängert werden.";
  elements.extendButton.disabled = !canExtendCurrentGroup();
}

function renderParticipants(people, result) {
  if (people.length === 0) {
    elements.participantList.innerHTML = `<div class="empty-state">Noch keine Personen.</div>`;
    return;
  }

  elements.participantList.innerHTML = people
    .map((person) => {
      const paid = result.paidByPerson[person.id] || 0;
      return `
        <div class="person-row">
          <div class="person-main">
            <div class="person-name">${escapeHtml(person.name)}</div>
            <div class="person-meta">Bezahlt: ${formatMoney(paid)}</div>
          </div>
          <div class="row-actions">
            <button class="button small secondary" type="button" data-action="rename-person" data-id="${person.id}">Umbenennen</button>
            <button class="button small danger" type="button" data-action="delete-person" data-id="${person.id}">Entfernen</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderPayerSelect(people) {
  const previousValue = elements.expensePayer.value;
  elements.expensePayer.innerHTML = people
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join("");

  if (state.participants[previousValue]) {
    elements.expensePayer.value = previousValue;
  }

  elements.expensePayer.disabled = people.length === 0;
}

function renderSplitList() {
  const people = getParticipants();
  const disabled = elements.splitAll.checked;
  elements.splitList.classList.toggle("disabled", disabled);
  elements.splitList.innerHTML = people
    .map(
      (person) => `
        <label class="split-chip">
          <input type="checkbox" value="${person.id}" ${disabled ? "checked disabled" : "checked"} />
          <span>${escapeHtml(person.name)}</span>
        </label>
      `,
    )
    .join("");
}

function renderExpenses(expenses) {
  if (expenses.length === 0) {
    elements.expenseList.innerHTML = `<div class="empty-state">Noch keine Ausgaben.</div>`;
    return;
  }

  elements.expenseList.innerHTML = expenses
    .map((expense) => {
      const payer = state.participants[expense.payerId]?.name || "Unbekannt";
      const splitNames = expense.participantIds
        .map((id) => state.participants[id]?.name)
        .filter(Boolean)
        .join(", ");

      return `
        <div class="expense-row">
          <div class="expense-main">
            <div class="expense-title">${escapeHtml(expense.title)}</div>
            <div class="expense-meta">${escapeHtml(payer)} · ${escapeHtml(splitNames || "Keine Aufteilung")}</div>
          </div>
          <div class="row-actions">
            <strong class="expense-amount">${formatMoney(expense.amountCents)}</strong>
            <button class="button small danger" type="button" data-action="delete-expense" data-id="${expense.id}">Löschen</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSummary(result) {
  const people = getParticipants();
  if (people.length === 0) {
    elements.summaryGrid.innerHTML = `<div class="empty-state">Noch keine Bilanz.</div>`;
    return;
  }

  elements.summaryGrid.innerHTML = people
    .map((person) => {
      const balance = result.balanceByPerson[person.id] || 0;
      const owed = result.owedByPerson[person.id] || 0;
      const modifier = balance > 0 ? "positive" : balance < 0 ? "negative" : "neutral";
      const prefix = balance > 0 ? "+" : "";
      return `
        <div class="summary-row ${modifier}">
          <div>
            <div class="person-name">${escapeHtml(person.name)}</div>
            <div class="summary-meta">Anteil: ${formatMoney(owed)}</div>
          </div>
          <strong class="summary-amount">${prefix}${formatMoney(balance)}</strong>
        </div>
      `;
    })
    .join("");
}

function renderSettlements(result) {
  if (result.settlements.length === 0) {
    elements.settlementList.innerHTML = `<div class="empty-state">Alles ausgeglichen.</div>`;
    return;
  }

  elements.settlementList.innerHTML = result.settlements
    .map((settlement) => {
      const from = state.participants[settlement.from]?.name || "Unbekannt";
      const to = state.participants[settlement.to]?.name || "Unbekannt";
      return `
        <div class="settlement-row">
          <div class="settlement-main">
            <div class="settlement-text">${escapeHtml(from)} → ${escapeHtml(to)}</div>
          </div>
          <strong class="settlement-amount">${formatMoney(settlement.amountCents)}</strong>
        </div>
      `;
    })
    .join("");
}

function calculateResult() {
  const people = getParticipants();
  const validIds = new Set(people.map((person) => person.id));
  const paidByPerson = Object.fromEntries(people.map((person) => [person.id, 0]));
  const owedByPerson = Object.fromEntries(people.map((person) => [person.id, 0]));
  let totalCents = 0;

  for (const expense of getExpenses()) {
    if (!validIds.has(expense.payerId)) continue;

    const participantIds = expense.participantIds.filter((id) => validIds.has(id));
    if (participantIds.length === 0) continue;

    paidByPerson[expense.payerId] += expense.amountCents;
    totalCents += expense.amountCents;

    const baseShare = Math.floor(expense.amountCents / participantIds.length);
    const remainder = expense.amountCents % participantIds.length;

    participantIds.forEach((id, index) => {
      owedByPerson[id] += baseShare + (index < remainder ? 1 : 0);
    });
  }

  const balanceByPerson = Object.fromEntries(
    people.map((person) => [person.id, (paidByPerson[person.id] || 0) - (owedByPerson[person.id] || 0)]),
  );

  const debtors = people
    .map((person) => ({ id: person.id, amount: -(balanceByPerson[person.id] || 0) }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const creditors = people
    .map((person) => ({ id: person.id, amount: balanceByPerson[person.id] || 0 }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountCents = Math.min(debtor.amount, creditor.amount);

    settlements.push({ from: debtor.id, to: creditor.id, amountCents });
    debtor.amount -= amountCents;
    creditor.amount -= amountCents;

    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }

  return {
    totalCents,
    paidByPerson,
    owedByPerson,
    balanceByPerson,
    settlements,
  };
}

function createEmptyState(id = "") {
  const timestamp = Date.now();
  return {
    version: 1,
    id,
    title: "Abend",
    currency: "EUR",
    participants: {},
    expenses: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp + DEFAULT_EXPIRY_MS,
  };
}

function normalizeState(rawState) {
  const fallback = createEmptyState(rawState?.id);
  const participants = Array.isArray(rawState?.participants)
    ? Object.fromEntries(rawState.participants.map((person) => [person.id, person]))
    : rawState?.participants || {};
  const expenses = Array.isArray(rawState?.expenses)
    ? Object.fromEntries(rawState.expenses.map((expense) => [expense.id, expense]))
    : rawState?.expenses || {};

  return {
    ...fallback,
    ...rawState,
    title: rawState?.title || fallback.title,
    currency: sanitizeCurrency(rawState?.currency || fallback.currency),
    participants,
    expenses,
    expiresAt: Number(rawState?.expiresAt || fallback.expiresAt),
  };
}

function canExtendCurrentGroup() {
  const expiresAt = Number(state.expiresAt || 0);
  const remainingMs = expiresAt - Date.now();
  return Boolean(state.id) && remainingMs > 0 && remainingMs <= EXTENSION_WINDOW_MS;
}

function getParticipants() {
  return Object.values(state.participants || {}).sort((a, b) => a.createdAt - b.createdAt);
}

function getExpenses() {
  return Object.values(state.expenses || {}).sort((a, b) => b.createdAt - a.createdAt);
}

function getGroupIdFromUrl() {
  const pathMatch = window.location.pathname.match(/^\/g\/([^/]+)\/?$/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  return new URL(window.location.href).searchParams.get("group");
}

function buildGroupLink(groupId) {
  return `${window.location.origin}/g/${encodeURIComponent(groupId)}`;
}

function setGroupUrl(groupId) {
  window.history.replaceState({}, "", `/g/${encodeURIComponent(groupId)}`);
}

function makeId(prefix) {
  const random = crypto?.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(36).padStart(2, "0")).join("")
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}${random}`.slice(0, 24);
}

function parseMoneyInput(input) {
  const raw = input.trim().replace(/\s/g, "");
  if (!raw) return 0;

  const commaIndex = raw.lastIndexOf(",");
  const dotIndex = raw.lastIndexOf(".");
  const decimalSeparator = commaIndex > dotIndex ? "," : ".";
  let normalized = raw;

  if (commaIndex >= 0 || dotIndex >= 0) {
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  }

  normalized = normalized.replace(/[^0-9.-]/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

function formatMoney(cents) {
  const currency = sanitizeCurrency(state.currency);
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function sanitizeCurrency(value) {
  const currency = String(value || "EUR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function setFieldValue(input, value) {
  if (document.activeElement !== input) {
    input.value = value;
  }
}

function setSyncStatus(text, mode, title) {
  elements.syncStatus.textContent = text;
  elements.syncStatus.title = title || "";
  elements.syncStatus.className = `sync-pill ${mode || ""}`.trim();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
}

function showExpired(message) {
  stopPolling();
  setSyncStatus("Abgelaufen", "error", "Dieser Link ist nicht mehr gültig.");
  elements.expiryDate.textContent = "Ablauf: abgelaufen";
  elements.expiryDate.classList.add("expired");
  elements.extendButton.disabled = true;
  showToast(message || "Dieser Link ist abgelaufen.");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
