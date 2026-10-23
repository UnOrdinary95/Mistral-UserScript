// ==UserScript==
// @name         Mistral Bulk Chat Manager
// @namespace    local.mistral-bulk-chat-manager
// @version      1.0.0
// @description  Select, archive, or delete chats outside projects on Mistral AI.
// @match        https://chat.mistral.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const API_ROOT = "/api/trpc/";
  const PRODUCT_TYPE = "work";
  const PAGE_SIZE = 50;
  const MAX_MUTATIONS_PER_BATCH = 20;
  const REQUEST_DELAY_MS = 700;
  const selectedIds = new Set();
  let chats = [];
  let isRunning = false;
  let stopRequested = false;
  let panel;
  let listElement;
  let statusElement;
  let countElement;
  let searchElement;

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const wait = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds));

  function getChatTitle(chat) {
    return chat.userTitle || chat.generatedTitle || chat.title || "Untitled chat";
  }

  async function trpcQuery(procedure, input) {
    const envelope = { 0: { json: input } };
    if (input.cursor instanceof Date) {
      envelope[0].json.cursor = input.cursor.toISOString();
      envelope[0].meta = { values: { cursor: ["Date"] }, v: 1 };
    }

    const url = `${API_ROOT}${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify(envelope))}`;
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "x-trpc-source": "nextjs-react" },
    });
    const payload = await response.json();
    if (!response.ok || payload[0]?.error) {
      throw new Error(readTrpcError(payload[0]?.error) || `Erreur HTTP ${response.status}`);
    }
    return payload[0]?.result?.data?.json;
  }

  function readTrpcError(error) {
    return error?.json?.message || error?.message || "Erreur API inconnue";
  }

  async function trpcMutationBatch(action, selectedChats) {
    const procedure = action === "delete" ? "chat.delete" : "chat.setPermission";
    const inputs = selectedChats.map((chat) => action === "delete"
      ? { id: chat.id }
      : { id: chat.id, permission: "read-only" });
    const batchPath = inputs.map(() => procedure).join(",");
    const batchInput = Object.fromEntries(inputs.map((input, index) => [index, { json: input }]));
    const response = await fetch(`${API_ROOT}${batchPath}?batch=1`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-trpc-source": "nextjs-react",
      },
      body: JSON.stringify(batchInput),
    });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload) || payload.length !== selectedChats.length) {
      throw new Error(readTrpcError(payload?.[0]?.error) || `Invalid batch response (HTTP ${response.status}).`);
    }
    return payload.map((item) => item?.error
      ? { error: readTrpcError(item.error) }
      : { success: true });
  }

  async function fetchChats() {
    const allChats = [];
    let cursor;
    const seenCursors = new Set();

    do {
      const input = {
        chatVisibility: "private",
        chatPermission: "write",
        includeProjectChats: false,
        productType: PRODUCT_TYPE,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor: new Date(cursor) } : {}),
      };
      const page = await trpcQuery("chat.last", input);
      if (!page || !Array.isArray(page.items)) {
        throw new Error("Unexpected response from the chat list.");
      }

      allChats.push(...page.items.filter((chat) => chat.projectId == null));
      cursor = page.nextCursor || undefined;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error("Pagination returned a cursor that was already used.");
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);

    return allChats;
  }

  function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.dataset.error = String(isError);
  }

  function renderList() {
    const query = searchElement.value.trim().toLocaleLowerCase();
    const visibleChats = chats.filter((chat) => getChatTitle(chat).toLocaleLowerCase().includes(query));
    listElement.replaceChildren();

    if (!visibleChats.length) {
      const empty = document.createElement("div");
      empty.className = "mbcm-empty";
      empty.textContent = chats.length ? "No results." : "No chats outside projects.";
      listElement.append(empty);
    } else {
      for (const chat of visibleChats) {
        const row = document.createElement("label");
        row.className = "mbcm-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedIds.has(chat.id);
        checkbox.dataset.chatId = chat.id;
        const title = document.createElement("span");
        title.className = "mbcm-title";
        title.textContent = getChatTitle(chat);
        row.append(checkbox, title);
        listElement.append(row);
      }
    }

    countElement.textContent = `${selectedIds.size} selected / ${chats.length}`;
    const selectAllButton = panel.querySelector("#mbcm-select-all");
    const allSelected = chats.length > 0 && chats.every((chat) => selectedIds.has(chat.id));
    selectAllButton.textContent = allSelected ? "Deselect all" : "Select all";
    selectAllButton.disabled = isRunning || chats.length === 0;
    panel.querySelectorAll("button[data-needs-selection]").forEach((button) => {
      button.disabled = isRunning || selectedIds.size === 0;
    });
    panel.querySelectorAll("button[data-needs-idle]").forEach((button) => {
      button.disabled = isRunning;
    });
    panel.querySelector("#mbcm-stop").hidden = !isRunning;
  }

  async function refreshChats() {
    if (isRunning) return;
    setStatus("Loading chats…");
    panel.querySelector("#mbcm-refresh").disabled = true;
    try {
      chats = await fetchChats();
      const existingIds = new Set(chats.map((chat) => chat.id));
      for (const id of selectedIds) {
        if (!existingIds.has(id)) selectedIds.delete(id);
      }
      setStatus(`${chats.length} chat${chats.length === 1 ? "" : "s"} outside projects loaded.`);
      renderList();
    } catch (error) {
      setStatus(`Failed to load chats: ${error.message}`, true);
    } finally {
      panel.querySelector("#mbcm-refresh").disabled = false;
      renderList();
    }
  }

  async function runBulkAction(action) {
    if (isRunning || selectedIds.size === 0) return;
    const selectedChats = chats.filter((chat) => selectedIds.has(chat.id) && chat.projectId == null);
    if (!selectedChats.length) {
      setStatus("No chats outside projects are selected.", true);
      return;
    }

    const actionName = action === "delete" ? "delete" : "archive";
    const confirmation = window.confirm(
      `Confirm: ${actionName} ${selectedChats.length} chat${selectedChats.length === 1 ? "" : "s"}?\n\nRequests will be sent in batches of up to ${MAX_MUTATIONS_PER_BATCH}.`,
    );
    if (!confirmation) return;

    isRunning = true;
    stopRequested = false;
    let succeeded = 0;
    const failures = [];
    renderList();

    const batches = [];
    for (let index = 0; index < selectedChats.length; index += MAX_MUTATIONS_PER_BATCH) {
      batches.push(selectedChats.slice(index, index + MAX_MUTATIONS_PER_BATCH));
    }

    for (const [batchIndex, batch] of batches.entries()) {
      if (stopRequested) break;
      const batchStart = batchIndex * MAX_MUTATIONS_PER_BATCH + 1;
      const batchEnd = batchStart + batch.length - 1;
      setStatus(`${action === "delete" ? "Deleting" : "Archiving"} ${batchStart}–${batchEnd}/${selectedChats.length}…`);
      try {
        const results = await trpcMutationBatch(action, batch);
        results.forEach((result, index) => {
          const chat = batch[index];
          if (result.error) {
            failures.push(`${getChatTitle(chat)} : ${result.error}`);
          } else {
            succeeded += 1;
            selectedIds.delete(chat.id);
          }
        });
      } catch (error) {
        failures.push(...batch.map((chat) => `${getChatTitle(chat)} : ${error.message}`));
      }
      renderList();
      if (batchIndex < batches.length - 1 && !stopRequested) await wait(REQUEST_DELAY_MS);
    }

    isRunning = false;
    const stopped = stopRequested;
    await refreshChats();
    if (failures.length) {
      const summary = `${succeeded} succeeded, ${failures.length} failed${stopped ? "; stop requested" : ""}.`;
      setStatus(`${summary} ${failures[0]}`, true);
    } else {
      setStatus(`${succeeded} chat${succeeded === 1 ? "" : "s"} ${action === "delete" ? "deleted" : "archived"}${stopped ? " before stopping" : ""}.`);
    }
  }

  function createPanel() {
    if (document.querySelector("#mbcm-root")) return;

    const style = document.createElement("style");
    style.textContent = `
      #mbcm-root { position: fixed; z-index: 2147483000; right: 18px; bottom: 18px; width: min(390px, calc(100vw - 36px)); color: #f4f4f5; font: 13px/1.4 system-ui, sans-serif; }
      #mbcm-root * { box-sizing: border-box; }
      #mbcm-toggle { display: block; margin-left: auto; border: 1px solid #414146; border-radius: 999px; padding: 10px 14px; background: #252529; color: inherit; box-shadow: 0 8px 28px #0006; cursor: pointer; }
      #mbcm-panel { display: none; overflow: hidden; margin-bottom: 10px; border: 1px solid #414146; border-radius: 14px; background: #1c1c1f; box-shadow: 0 12px 38px #0008; }
      #mbcm-panel[data-open="true"] { display: block; }
      .mbcm-head, .mbcm-actions, .mbcm-selection { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
      .mbcm-head { justify-content: space-between; border-bottom: 1px solid #343438; font-weight: 650; }
      .mbcm-head button, .mbcm-actions button, .mbcm-selection button { border: 1px solid #45454b; border-radius: 8px; padding: 6px 9px; background: #29292e; color: inherit; cursor: pointer; }
      #mbcm-refresh { margin-left: auto; }
      #mbcm-search { width: calc(100% - 24px); margin: 10px 12px 2px; border: 1px solid #45454b; border-radius: 8px; padding: 8px 10px; outline: none; background: #131316; color: inherit; }
      #mbcm-list { max-height: min(42vh, 360px); overflow-y: auto; padding: 4px 8px; }
      .mbcm-row { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 5px 6px; border-radius: 7px; cursor: pointer; }
      .mbcm-row:hover { background: #2b2b30; }
      .mbcm-row input { accent-color: #8b8bff; }
      .mbcm-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mbcm-empty { padding: 12px; color: #a1a1aa; }
      .mbcm-selection { justify-content: space-between; padding-top: 5px; color: #b4b4bc; font-size: 12px; }
      .mbcm-actions { padding-top: 5px; }
      .mbcm-actions button { flex: 1; }
      .mbcm-actions #mbcm-delete { border-color: #713a3a; color: #ffb4b4; }
      #mbcm-stop { border-color: #93642e; color: #ffd28a; }
      #mbcm-status { min-height: 34px; padding: 2px 12px 10px; color: #b4b4bc; font-size: 12px; overflow-wrap: anywhere; }
      #mbcm-status[data-error="true"] { color: #ff9e9e; }
      #mbcm-root button:disabled { opacity: .45; cursor: not-allowed; }
      #mbcm-root button[hidden] { display: none; }
    `;

    const root = document.createElement("div");
    root.id = "mbcm-root";
    root.innerHTML = `
      <section id="mbcm-panel" data-open="false" aria-label="Chat manager">
        <header class="mbcm-head"><span>Chats outside projects</span><button id="mbcm-refresh" data-needs-idle type="button">Refresh</button></header>
        <input id="mbcm-search" type="search" placeholder="Search chats" aria-label="Search chats">
        <div id="mbcm-list" aria-live="polite"></div>
        <div class="mbcm-selection"><span id="mbcm-count">0 selected / 0</span><button id="mbcm-select-all" data-needs-idle type="button">Select all</button></div>
        <div class="mbcm-actions">
          <button id="mbcm-archive" data-needs-selection type="button">Archive selected</button>
          <button id="mbcm-delete" data-needs-selection type="button">Delete selected</button>
          <button id="mbcm-stop" type="button" hidden>Stop after the current batch</button>
        </div>
        <div id="mbcm-status" role="status"></div>
      </section>
      <button id="mbcm-toggle" type="button" aria-expanded="false">Manage chats</button>
    `;
    document.head.append(style);
    document.body.append(root);

    panel = root.querySelector("#mbcm-panel");
    listElement = root.querySelector("#mbcm-list");
    statusElement = root.querySelector("#mbcm-status");
    countElement = root.querySelector("#mbcm-count");
    searchElement = root.querySelector("#mbcm-search");

    root.querySelector("#mbcm-toggle").addEventListener("click", (event) => {
      const isOpen = panel.dataset.open !== "true";
      panel.dataset.open = String(isOpen);
      event.currentTarget.setAttribute("aria-expanded", String(isOpen));
      if (isOpen && !chats.length) refreshChats();
    });
    root.querySelector("#mbcm-refresh").addEventListener("click", refreshChats);
    root.querySelector("#mbcm-select-all").addEventListener("click", () => {
      const allSelected = chats.length > 0 && chats.every((chat) => selectedIds.has(chat.id));
      if (allSelected) selectedIds.clear();
      else chats.forEach((chat) => selectedIds.add(chat.id));
      renderList();
    });
    root.querySelector("#mbcm-archive").addEventListener("click", () => runBulkAction("archive"));
    root.querySelector("#mbcm-delete").addEventListener("click", () => runBulkAction("delete"));
    root.querySelector("#mbcm-stop").addEventListener("click", () => {
      stopRequested = true;
      setStatus("Stop requested; the current batch will finish.");
    });
    searchElement.addEventListener("input", renderList);
    listElement.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[data-chat-id]");
      if (!checkbox) return;
      if (checkbox.checked) selectedIds.add(checkbox.dataset.chatId);
      else selectedIds.delete(checkbox.dataset.chatId);
      renderList();
    });

    renderList();
  }

  function initialize() {
    if (!document.body) return;
    createPanel();
  }

  initialize();
  new MutationObserver(() => {
    if (!document.querySelector("#mbcm-root")) initialize();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
