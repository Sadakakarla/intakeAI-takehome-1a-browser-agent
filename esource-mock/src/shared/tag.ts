/**
 * No-op element tagging.
 *
 * The renderer calls `tag(el, 'some-control-id')` at construction time. In the
 * internal test harness this stamped an attribute used as an answer key. That
 * attribute is deliberately NOT emitted here: an eSource in the wild does not
 * label its own controls for you, and an agent that leaned on such a hook
 * would not generalize past this one page.
 *
 * The calls are left in place so the renderer reads the same as upstream.
 */
export function tag<T extends Element>(el: T, _id?: string, _index?: number): T {
  return el;
}
