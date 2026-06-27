// public/express-plus-client.mjs
// A tiny client library for live updates + re-render. Two pieces:
//   1. LiveChannel  — subscribe to an app.room() path, auto-reconnect,
//                     dispatch events to handlers.
//   2. LiveList     — boots from a JSON snapshot, then applies realtime
//                     deltas to an in-memory array and re-renders.
//
// Usage is deliberately small so the page logic stays declarative.

export class LiveChannel {
  constructor(path, { token } = {}) {
    this.path = path;
    this.token = token;
    this.handlers = new Map();
    this.ws = null;
    this._connect();
  }

  on(event, fn) {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)).add(fn);
    return this;
  }

  send(event, data) {
    this.ws?.send(JSON.stringify({ event, data }));
  }

  _connect() {
    const url = `ws://${location.host}${this.path}?token=${this.token}`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const { event, data } = JSON.parse(e.data);
      this.handlers.get(event)?.forEach((fn) => fn(data));
    };
    this.ws.onclose = () => setTimeout(() => this._connect(), 1000); // auto-reconnect
  }
}

// A reactive list: render() is called once on boot and again whenever a delta
// arrives. Keys are tracked so add/remove/patch become no-ops if nothing
// actually changed.
export class LiveList {
  constructor({ fetch, channel, render, key = 'id' }) {
    this.fetchUrl = fetch;
    this.channel = channel; // LiveChannel
    this.render = render;   // (items) -> DOM update
    this.key = key;
    this.items = [];
  }

  async start() {
    // 1. Bootstrap from the server's JSON snapshot.
    const res = await fetch(this.fetchUrl, { headers: { Authorization: `Bearer ${this.channel.token}` } });
    const boot = await res.json();
    this.items = [...boot.owned, ...boot.shared];

    // 2. Subscribe to realtime deltas from the inbox room.
    this.channel
      .on('share:added', (doc) => this._upsert({ ...doc, _shared: true }))
      .on('share:revoked', ({ id }) => this._remove(id))
      .on('doc:renamed', (doc) => this._upsert(doc))
      .on('doc:deleted', ({ id }) => this._remove(id));

    this._render();
  }

  _upsert(doc) {
    const i = this.items.findIndex((x) => x[this.key] === doc[this.key]);
    if (i === -1) this.items.push(doc);
    else this.items[i] = { ...this.items[i], ...doc };
    this._render();
  }

  _remove(id) {
    this.items = this.items.filter((x) => x[this.key] !== id);
    this._render();
  }

  _render() {
    // Sort newest activity first, then delegate to the page's render fn.
    this.items.sort((a, b) => new Date(b.updatedAt ?? b.sharedAt) - new Date(a.updatedAt ?? a.sharedAt));
    this.render(this.items);
  }
}
