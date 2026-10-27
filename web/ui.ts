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
