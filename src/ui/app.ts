import {
  limits,
  listingSchema,
  type Message,
  messageSchema,
  type Summary,
} from "../contracts.js";

function get<T extends HTMLElement>(id: string, kind: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`Missing UI element: ${id}`);
  return node;
}
const byId = (id: string) => get(id, HTMLElement);
const button = (id: string) => get(id, HTMLButtonElement);
const search = get("search", HTMLInputElement);
const dialog = get("confirm-dialog", HTMLDialogElement);
const frame = get("html-body", HTMLIFrameElement);
const app = document.querySelector(".app");
const narrow = matchMedia("(max-width: 760px)");
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
const addresses = (message: Pick<Summary, "To">) =>
  message.To.map((address) =>
    address.Name ? `${address.Name} <${address.Email}>` : address.Email,
  ).join(", ");

let messages: Summary[] = [];
let selected: Message | null = null;
let selectedId: string | null = null;
let selectedRead = true;
let filter: "all" | "unread" = "all";
let page = 0;
let view: "html" | "text" = "html";
let loaded = false;
let refreshing = false;
let selecting = false;
let mutating = false;
let refreshEpoch = 0;
let selectionEpoch = 0;
let pendingDelete: { id: string | null; trigger: HTMLElement } | null = null;
const pageSize = 10;

function announce(text: string, error = false) {
  byId("announcement").textContent = text;
  byId("announcement").dataset.error = String(error);
}

class RequestError extends Error {
  constructor(readonly status: number) {
    super("Request failed");
  }
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new RequestError(response.status);
  return response;
}

async function mutate(method: string, body: unknown) {
  await request("/api/v1/messages", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function emptyMarkup(title: string, description: string) {
  return `<span class="empty-symbol" aria-hidden="true">✉</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>`;
}

function controls() {
  button("refresh").disabled = refreshing || selecting || mutating;
  button("retry").disabled = refreshing || selecting || mutating;
  button("clear-inbox").disabled = !messages.length || mutating || selecting;
  button("toggle-read").disabled = mutating || selecting || !selected;
  button("delete-message").disabled = mutating || selecting || !selected;
  button("toggle-read").textContent = selectedRead
    ? "Mark unread"
    : "Mark read";
}

function renderList() {
  const focusedId =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.message
      : undefined;
  const query = search.value.trim().toLowerCase();
  const filtered = messages.filter(
    (message) =>
      (filter === "all" || !message.Read) &&
      `${message.From.Name} ${message.From.Email} ${addresses(message)} ${message.Subject}`
        .toLowerCase()
        .includes(query),
  );
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const current = filtered.slice(page * pageSize, (page + 1) * pageSize);
  byId("all-count").textContent = String(messages.length);
  byId("unread-count").textContent = String(
    messages.filter((message) => !message.Read).length,
  );
  byId("header-count").textContent =
    !loaded && refreshing ? "Loading…" : `${messages.length} messages`;
  for (const name of ["all", "unread"]) {
    byId(`${name}-mail`).classList.toggle("active", filter === name);
    byId(`${name}-mail`).setAttribute("aria-pressed", String(filter === name));
  }
  byId("list-label").textContent =
    filter === "all" ? "ALL MESSAGES" : "UNREAD MESSAGES";
  byId("message-list").setAttribute("aria-busy", String(refreshing));
  if (!loaded && refreshing) {
    byId("message-list").innerHTML =
      '<span class="sr-only">Loading messages</span>' +
      '<div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'.repeat(
        3,
      );
  } else if (!filtered.length) {
    byId("message-list").innerHTML = `<div class="empty-state">${emptyMarkup(
      !loaded
        ? "Inbox unavailable"
        : messages.length
          ? filter === "unread" && !query
            ? "All read."
            : "No matching messages"
          : "An empty pint.",
      !loaded
        ? "Try refreshing the inbox."
        : messages.length
          ? "Try another filter or return to all messages."
          : "Messages sent to this mailbox will appear here.",
    )}${messages.length ? '<button type="button" id="reset-filter">Show all messages</button>' : ""}</div>`;
    document.getElementById("reset-filter")?.addEventListener("click", () => {
      search.value = "";
      filter = "all";
      page = 0;
      renderList();
      search.focus();
    });
  } else {
    byId("message-list").innerHTML = current
      .map(
        (message) => `
      <button type="button" class="message-row${selectedId === message.ID ? " selected" : ""}${!message.Read ? " unread" : ""}" data-message="${message.ID}" ${selectedId === message.ID ? 'aria-current="true"' : ""}>
        <span class="row-top">${!message.Read ? '<span class="unread-dot" aria-hidden="true"></span><span class="sr-only">Unread: </span>' : ""}<span class="row-sender">${escapeHtml(message.From.Name || message.From.Email)}</span><time class="row-time" datetime="${message.Created}" title="${escapeHtml(new Date(message.Created).toLocaleString())}">${escapeHtml(new Date(message.Created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time></span>
        <span class="row-subject">${escapeHtml(message.Subject || "(No subject)")}</span>
        <span class="row-recipient">To: ${escapeHtml(addresses(message))}</span>
        <span class="row-preview">${escapeHtml(message.Snippet)}</span>
      </button>`,
      )
      .join("");
  }
  const start = filtered.length ? page * pageSize + 1 : 0;
  byId("range").textContent =
    !loaded && refreshing
      ? "Loading messages…"
      : `${start}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length} messages`;
  button("newer").disabled = page === 0;
  button("older").disabled = (page + 1) * pageSize >= filtered.length;
  controls();
  if (focusedId) focusRow(focusedId);
}

function focusRow(id = selectedId) {
  const row = [
    ...document.querySelectorAll<HTMLElement>("[data-message]"),
  ].find((node) => node.dataset.message === id);
  (row ?? search).focus();
}

function backToInbox() {
  app?.classList.remove("reading");
  focusRow();
}

function emptyReader(
  title = "A little room for your mail.",
  description = "Select a message to inspect its contents.",
  retry = false,
) {
  byId("reader-content").hidden = true;
  byId("reader-empty").hidden = false;
  frame.removeAttribute("src");
  byId("plain-text").textContent = "";
  byId("reader-empty").innerHTML =
    `${emptyMarkup(title, description)}${retry ? '<button id="retry-message" type="button">Try again</button>' : ""}<button id="empty-back" type="button">Back to inbox</button>`;
  byId("empty-back").addEventListener("click", backToInbox);
  document.getElementById("retry-message")?.addEventListener("click", () => {
    if (selectedId) void selectMessage(selectedId);
  });
}

function setView(next: "html" | "text") {
  view = next;
  for (const name of ["html", "text"]) {
    byId(`${name}-body`).hidden = view !== name;
    byId(`view-${name}`).setAttribute("aria-pressed", String(view === name));
  }
}

function renderReader(message: Message) {
  byId("reader-content").hidden = false;
  byId("reader-empty").hidden = true;
  byId("subject").textContent = message.Subject || "(No subject)";
  byId("sender-name").textContent = message.From.Name || message.From.Email;
  byId("sender-email").textContent = message.From.Email;
  byId("avatar").textContent = (message.From.Name || message.From.Email).slice(
    0,
    1,
  );
  byId("recipient").textContent = addresses(message);
  const received = get("received-at", HTMLTimeElement);
  received.dateTime = message.Date;
  received.textContent = new Date(message.Date).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "long",
  });
  frame.src = `/view/${message.ID}.html`;
  byId("plain-text").textContent =
    message.Text || "This message has no text body.";
  byId("text-body").scrollTop = 0;
  setView(message.HTML ? "html" : "text");
}

function invalidateRefresh() {
  refreshEpoch++;
  refreshing = false;
}

async function selectMessage(id: string, open = true) {
  if (mutating) return;
  const epoch = ++selectionEpoch;
  invalidateRefresh();
  const changed = selected?.ID !== id;
  selectedId = id;
  selecting = true;
  if (open) app?.classList.add("reading");
  if (changed) {
    selected = null;
    emptyReader("Loading message…", "");
  }
  renderList();
  try {
    const response = await request(`/api/v1/message/${id}`);
    const message = messageSchema.parse(await response.json());
    if (epoch !== selectionEpoch) return;
    selected = message;
    selectedRead = true;
    const summary = messages.find((item) => item.ID === id);
    if (summary) summary.Read = true;
    if (changed) renderReader(message);
    if (open) {
      if (narrow.matches) byId("back").focus();
      else focusRow();
    }
  } catch (error) {
    if (epoch !== selectionEpoch) return;
    if (changed || (error instanceof RequestError && error.status === 404)) {
      selected = null;
      emptyReader(
        "Message unavailable",
        "It may have been deleted. Choose another message or try again.",
        true,
      );
      if (open) byId("empty-back").focus();
    }
    announce("Couldn't load the message.", true);
  } finally {
    if (epoch === selectionEpoch) {
      selecting = false;
      renderList();
    }
  }
}

async function refresh(initial = false) {
  if (mutating || selecting) return;
  const epoch = ++refreshEpoch;
  refreshing = true;
  renderList();
  try {
    const response = await request(`/api/v1/messages?limit=${limits.messages}`);
    const data = listingSchema.parse(await response.json());
    if (epoch !== refreshEpoch) return;
    messages = data.messages;
    loaded = true;
    byId("refresh-error").hidden = true;
    const summary = messages.find((item) => item.ID === selectedId);
    if (selectedId && !summary) {
      selected = null;
      emptyReader(
        "Message unavailable",
        "It may have been deleted. Choose another message or return to the inbox.",
      );
    } else if (summary) selectedRead = summary.Read;
    announce("Inbox up to date.");
    if (initial && !narrow.matches && messages[0]) {
      refreshing = false;
      await selectMessage(messages[0].ID, false);
    }
  } catch {
    if (epoch !== refreshEpoch) return;
    byId("refresh-error").hidden = false;
    byId("error-copy").textContent = loaded
      ? "Couldn't refresh the inbox. Showing previously loaded messages."
      : "Couldn't load the inbox.";
    announce("Couldn't refresh the inbox.", true);
  } finally {
    if (epoch === refreshEpoch) {
      refreshing = false;
      renderList();
    }
  }
}

async function toggleRead() {
  if (!selected || mutating || selecting) return;
  const id = selected.ID;
  const read = !selectedRead;
  invalidateRefresh();
  mutating = true;
  controls();
  try {
    await mutate("PUT", { IDs: [id], Read: read });
    selectedRead = read;
    const summary = messages.find((item) => item.ID === id);
    if (summary) summary.Read = read;
    announce(read ? "Message marked read." : "Message marked unread.");
  } catch {
    announce("Couldn't update read status. Try again.", true);
  } finally {
    mutating = false;
    renderList();
  }
}

function requestDelete(all: boolean, trigger: HTMLElement) {
  if (mutating || selecting || (!all && !selected)) return;
  pendingDelete = { id: all ? null : selectedId, trigger };
  byId("confirm-title").textContent = all
    ? "Clear the inbox?"
    : "Delete this message?";
  byId("confirm-description").textContent = all
    ? "All messages will be deleted. This can't be undone."
    : `“${selected?.Subject || "(No subject)"}” will be deleted. This can't be undone.`;
  byId("confirm-action").textContent = all ? "Clear inbox" : "Delete message";
  dialog.returnValue = "";
  dialog.showModal();
}

async function confirmDelete() {
  const pending = pendingDelete;
  pendingDelete = null;
  if (!pending) return;
  if (dialog.returnValue !== "confirm") {
    pending.trigger.focus();
    return;
  }
  invalidateRefresh();
  selectionEpoch++;
  mutating = true;
  controls();
  try {
    await mutate("DELETE", { IDs: pending.id ? [pending.id] : [] });
    messages = pending.id
      ? messages.filter((message) => message.ID !== pending.id)
      : [];
    if (!pending.id || selectedId === pending.id) {
      selected = null;
      selectedId = null;
      emptyReader();
      app?.classList.remove("reading");
    }
    announce(pending.id ? "Message deleted." : "Inbox cleared.");
    search.focus();
  } catch {
    announce("Couldn't delete messages. Refresh before trying again.", true);
    pending.trigger.focus();
  } finally {
    mutating = false;
    renderList();
  }
}

byId("message-list").addEventListener("click", (event) => {
  const row =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-message]")
      : null;
  if (row?.dataset.message) void selectMessage(row.dataset.message);
});
byId("back").addEventListener("click", backToInbox);
document.querySelector(".brand")?.addEventListener("click", () => {
  filter = "all";
  search.value = "";
  page = 0;
  renderList();
  backToInbox();
});
for (const name of ["html", "text"] as const) {
  byId(`view-${name}`).addEventListener("click", () => setView(name));
}
for (const name of ["all", "unread"] as const) {
  byId(`${name}-mail`).addEventListener("click", () => {
    filter = name;
    page = 0;
    renderList();
    app?.classList.remove("reading");
  });
}
search.addEventListener("input", () => {
  page = 0;
  renderList();
});
byId("newer").addEventListener("click", () => {
  page--;
  renderList();
  search.focus();
});
byId("older").addEventListener("click", () => {
  page++;
  renderList();
  search.focus();
});
byId("toggle-read").addEventListener("click", () => {
  void toggleRead();
});
byId("delete-message").addEventListener("click", () =>
  requestDelete(false, byId("delete-message")),
);
byId("clear-inbox").addEventListener("click", () =>
  requestDelete(true, byId("clear-inbox")),
);
dialog.addEventListener("close", () => {
  void confirmDelete();
});
byId("refresh").addEventListener("click", () => {
  void refresh();
});
byId("retry").addEventListener("click", () => {
  void refresh();
});

function setTheme(theme: string) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  byId("theme").setAttribute("aria-pressed", String(dark));
}
let savedTheme: string | null = null;
try {
  savedTheme = localStorage.getItem("mailpint-theme");
} catch {
  /* Optional preference. */
}
setTheme(
  new URLSearchParams(location.search).get("theme") ??
    savedTheme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);
byId("theme").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(theme);
  try {
    localStorage.setItem("mailpint-theme", theme);
  } catch {
    /* Optional preference. */
  }
});
emptyReader();
void refresh(true);
