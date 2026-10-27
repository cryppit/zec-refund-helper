// Small DOM helpers shared by the deposit page and the address page. Everything is built with textContent, never parsed
// as HTML.

export function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} is missing`);
  return e as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; href?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.href && e instanceof HTMLAnchorElement) {
    e.href = props.href;
    if (props.href.startsWith("https:")) {
      e.target = "_blank";
      e.rel = "noopener noreferrer";
    }
  }
  e.append(...children);
  return e;
}

/** A chain logo in a glowing coin, with an optional badge (✓, ✕, →…), in the journey's style. */
export function coin(logo: "zec" | "near" | "btc", badge = ""): HTMLElement {
  const img = document.createElement("img");
  img.className = "jlogo";
  img.src = `logos/${logo}.svg`;
  img.alt = "";
  img.width = 22;
  img.height = 22;
  const node = el("span", { className: "jnode" }, img, el("span", { className: "jbadge", text: badge }));
  node.setAttribute("aria-hidden", "true");
  return node;
}

/** What shows while a check reads public data: a glowing card that says what is being read, so nobody thinks it froze. */
export function loading(title: string, detail: string): HTMLElement {
  const box = el("div", { className: "loading" }, el("span", { className: "ld-orb" }), el("div", { className: "ld-text" }, el("b", { text: title }), el("span", { text: detail })), el("span", { className: "ld-bar" }));
  box.setAttribute("role", "status");
  box.querySelector(".ld-orb")?.setAttribute("aria-hidden", "true");
  box.querySelector(".ld-bar")?.setAttribute("aria-hidden", "true");
  return box;
}
