const API_BASE = "/api";
const POLL_INTERVAL_MS = 3500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_MS = 28 * DAY_MS;
const EXTENSION_WINDOW_MS = 7 * DAY_MS;
const NAME_COLLATOR = new Intl.Collator("de-DE", { sensitivity: "base", numeric: true });

const elements = {
  syncStatus: document.querySelector("#syncStatus"),
  toast: document.querySelector("#toast"),
  entryControls: document.querySelector("#entryControls"),
  entryControlsToggle: document.querySelector("#entryControlsToggle"),
  eventForm: document.querySelector("#eventForm"),
  expiryDate: document.querySelector("#expiryDate"),
  extendButton: document.querySelector("#extendButton"),
  eventTitle: document.querySelector("#eventTitle"),
  eventCurrency: document.querySelector("#eventCurrency"),
  participantForm: document.querySelector("#participantForm"),
  participantName: document.querySelector("#participantName"),
  participantAmount: document.querySelector("#participantAmount"),
  participantCount: document.querySelector("#participantCount"),
  participantList: document.querySelector("#participantList"),
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
let editingParticipantId = "";
let entryControlsExpanded = true;

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
    const name = cleanName(elements.participantName.value);
    const paidCents = parseMoneyInput(elements.participantAmount.value);

    if (!name) {
      showToast("Bitte einen Namen eintragen.");
      return;
    }

    if (isDuplicateName(name)) {
      showToast("Dieser Name ist schon vergeben.");
      return;
    }

    if (paidCents === null) {
      showToast("Bitte einen gültigen Betrag eintragen.");
      return;
    }

    const id = makeId("p");
    state.participants[id] = { id, name, paidCents, createdAt: Date.now() };
    elements.participantForm.reset();
    persist();
  });

  document.addEventListener("focusin", (event) => {
    if (isAmountInput(event.target)) {
      moveCursorToEnd(event.target);
    }
  });

  document.addEventListener("click", async (event) => {
    if (isAmountInput(event.target)) {
      moveCursorToEnd(event.target);
    }

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

    if (action === "toggle-entry-controls") {
      toggleEntryControls();
    }

    if (action === "start-edit-person") {
      startEditParticipant(id);
    }

    if (action === "save-person") {
      saveParticipantEdit(id);
    }

    if (action === "cancel-edit-person") {
      cancelParticipantEdit();
    }

    if (action === "delete-person") {
      deleteParticipant(id);
    }
  });
}

async function loadGroup(groupId) {
  setSyncStatus("Lädt", "cloud", "Runde wird geladen.");
  const response = await fetchJson(`${API_BASE}/groups/${encodeURIComponent(groupId)}`);
  state = normalizeState(response.state);
  lastSyncedAt = Number(state.updatedAt) || 0;
  setDefaultEntryControlsState();
  setGroupUrl(state.id);
  setSyncStatus("Bereit", "cloud", "Alle mit Link können bearbeiten.");
  render();
}

async function createNewGroup({ askConfirmation }) {
  const hasContent = getParticipants().length > 0;
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
  setDefaultEntryControlsState();
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

function deleteParticipant(id) {
  if (!state.participants[id]) return;
  if (!window.confirm("Wirklich entfernen?")) return;

  if (editingParticipantId === id) {
    editingParticipantId = "";
  }
  delete state.participants[id];
  persist();
}

function setDefaultEntryControlsState() {
  entryControlsExpanded = getParticipants().length === 0;
}

function toggleEntryControls() {
  entryControlsExpanded = !entryControlsExpanded;
  render();
}

function startEditParticipant(id) {
  if (!state.participants[id]) return;
  editingParticipantId = id;
  render();
}

function cancelParticipantEdit() {
  editingParticipantId = "";
  render();
}

function saveParticipantEdit(id) {
  const person = state.participants[id];
  const row = getEditRow(id);
  if (!person || !row) return;

  const name = cleanName(row.querySelector("[data-edit-name]")?.value || "");
  const paidCents = parseMoneyInput(row.querySelector("[data-edit-amount]")?.value || "");

  if (!name) {
    showToast("Bitte einen Namen eintragen.");
    return;
  }

  if (isDuplicateName(name, id)) {
    showToast("Dieser Name ist schon vergeben.");
    return;
  }

  if (paidCents === null) {
    showToast("Bitte einen gültigen Betrag eintragen.");
    return;
  }

  state.participants[id] = { ...person, name, paidCents };
  editingParticipantId = "";
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
  state.expenses = {};
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
    if (error.status === 400) {
      showToast(error.message || "Speichern ist fehlgeschlagen.");
      await loadGroup(state.id);
      return;
    }
    setSyncStatus("Fehler", "error", "Speichern ist fehlgeschlagen.");
    showToast(error.message || "Speichern ist fehlgeschlagen.");
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
  const result = calculateResult();

  setFieldValue(elements.eventTitle, state.title);
  setFieldValue(elements.eventCurrency, state.currency);

  elements.participantCount.textContent = String(people.length);
  elements.totalAmount.textContent = formatMoney(result.totalCents);
  elements.settlementCount.textContent = String(result.settlements.length);

  renderExpiry();
  renderEntryControls(people);
  renderParticipants(people, result);
  renderSummary(people, result);
  renderSettlements(result);
}

function renderEntryControls(people) {
  const hasPeople = people.length > 0;
  const isExpanded = entryControlsExpanded || !hasPeople;

  elements.entryControls.hidden = !isExpanded;
  elements.entryControlsToggle.hidden = !hasPeople;
  elements.entryControlsToggle.textContent = isExpanded ? "Einklappen" : "Bearbeiten";
  elements.entryControlsToggle.setAttribute("aria-expanded", String(isExpanded));
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
      const owed = result.owedByPerson[person.id] || 0;
      if (editingParticipantId === person.id) {
        return `
          <div class="person-row editing" data-edit-row="${escapeHtml(person.id)}">
            <label>
              Name
              <input data-edit-name value="${escapeHtml(person.name)}" maxlength="60" autocomplete="off" />
            </label>
            <label>
              Bezahlt
              <input data-edit-amount value="${escapeHtml(formatPlainMoney(paid))}" inputmode="decimal" autocomplete="off" />
            </label>
            <div class="row-actions">
              <button class="button small primary" type="button" data-action="save-person" data-id="${escapeHtml(person.id)}">Speichern</button>
              <button class="button small secondary" type="button" data-action="cancel-edit-person" data-id="${escapeHtml(person.id)}">Abbrechen</button>
            </div>
          </div>
        `;
      }
      return `
        <div class="person-row">
          <div class="person-main">
            <div class="person-name">${escapeHtml(person.name)}</div>
            <div class="person-meta">Bezahlt: ${formatMoney(paid)} · Anteil: ${formatMoney(owed)}</div>
          </div>
          <strong class="person-paid">${formatMoney(paid)}</strong>
          <div class="row-actions">
            <button class="icon-button secondary" type="button" data-action="start-edit-person" data-id="${escapeHtml(person.id)}" aria-label="${escapeHtml(person.name)} bearbeiten" title="Bearbeiten">✎</button>
            <button class="icon-button danger" type="button" data-action="delete-person" data-id="${escapeHtml(person.id)}" aria-label="${escapeHtml(person.name)} entfernen" title="Entfernen">×</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSummary(people, result) {
  if (people.length === 0) {
    elements.summaryGrid.innerHTML = `<div class="empty-state">Noch keine Bilanz.</div>`;
    return;
  }

  elements.summaryGrid.innerHTML = people
    .map((person) => {
      const balance = result.balanceByPerson[person.id] || 0;
      const modifier = balance > 0 ? "positive" : balance < 0 ? "negative" : "neutral";
      const prefix = balance > 0 ? "+" : "";
      return `
        <div class="summary-row ${modifier}">
          <div>
            <div class="person-name">${escapeHtml(person.name)}</div>
            <div class="summary-meta">Bezahlt: ${formatMoney(result.paidByPerson[person.id] || 0)}</div>
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
  const paidByPerson = Object.fromEntries(people.map((person) => [person.id, Number(person.paidCents) || 0]));
  const owedByPerson = Object.fromEntries(people.map((person) => [person.id, 0]));
  const totalCents = people.reduce((sum, person) => sum + (Number(person.paidCents) || 0), 0);

  if (people.length > 0) {
    const baseShare = Math.floor(totalCents / people.length);
    const remainder = totalCents % people.length;
    people.forEach((person, index) => {
      owedByPerson[person.id] = baseShare + (index < remainder ? 1 : 0);
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
    version: 2,
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
  const rawParticipants = Array.isArray(rawState?.participants)
    ? Object.fromEntries(rawState.participants.map((person) => [person.id, person]))
    : rawState?.participants || {};
  const legacyExpenses = Array.isArray(rawState?.expenses)
    ? Object.fromEntries(rawState.expenses.map((expense) => [expense.id, expense]))
    : rawState?.expenses || {};
  const legacyPaidByPerson = sumLegacyExpenses(legacyExpenses);
  const hasDirectPayments = Object.values(rawParticipants).some((person) => person.paidCents !== undefined);
  const participants = Object.fromEntries(
    Object.values(rawParticipants).map((person) => [
      person.id,
      {
        ...person,
        paidCents: normalizeCents(hasDirectPayments ? person.paidCents : legacyPaidByPerson[person.id]),
      },
    ]),
  );

  return {
    ...fallback,
    ...rawState,
    version: 2,
    title: rawState?.title || fallback.title,
    currency: sanitizeCurrency(rawState?.currency || fallback.currency),
    participants,
    expenses: hasDirectPayments ? {} : legacyExpenses,
    expiresAt: Number(rawState?.expiresAt || fallback.expiresAt),
  };
}

function sumLegacyExpenses(expenses) {
  return Object.values(expenses || {}).reduce((totals, expense) => {
    if (expense?.payerId) {
      totals[expense.payerId] = (totals[expense.payerId] || 0) + normalizeCents(expense.amountCents);
    }
    return totals;
  }, {});
}

function normalizeCents(value) {
  const cents = Number(value) || 0;
  return cents > 0 ? Math.round(cents) : 0;
}

function canExtendCurrentGroup() {
  const expiresAt = Number(state.expiresAt || 0);
  const remainingMs = expiresAt - Date.now();
  return Boolean(state.id) && remainingMs > 0 && remainingMs <= EXTENSION_WINDOW_MS;
}

function getEditRow(id) {
  const escapedId = window.CSS?.escape ? CSS.escape(id) : id.replaceAll('"', '\\"');
  return document.querySelector(`[data-edit-row="${escapedId}"]`);
}

function isAmountInput(target) {
  return (
    target instanceof HTMLInputElement &&
    (target.id === "participantAmount" || target.hasAttribute("data-edit-amount"))
  );
}

function moveCursorToEnd(input) {
  window.setTimeout(() => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, 0);
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
  return cleanName(value).toLocaleLowerCase("de-DE");
}

function isDuplicateName(name, exceptId = "") {
  const normalizedName = normalizeName(name);
  return getParticipants().some((person) => person.id !== exceptId && normalizeName(person.name) === normalizedName);
}

function getParticipants() {
  return Object.values(state.participants || {}).sort((a, b) => {
    const byName = NAME_COLLATOR.compare(a.name || "", b.name || "");
    return byName || a.createdAt - b.createdAt;
  });
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
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function formatMoney(cents) {
  const currency = sanitizeCurrency(state.currency);
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function formatPlainMoney(cents) {
  return new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
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
