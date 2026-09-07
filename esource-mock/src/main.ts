import { Mock1Store } from './engine/store';
import { readState } from './engine/read-state';
import { installMockHarness } from './shared/read-state';
import { PLATFORM_ID, PLATFORM_LABEL, SPEC_VERSION } from './spec/surface';
import { mount } from './ui/render';

/**
 * Entry point.
 *
 * The store starts EMPTY. The study exists as a name and nothing else — no
 * visits, no source documents, no elements. Everything you see in the input
 * file has to be built through the UI.
 */
const root = document.getElementById('root');
if (!root) throw new Error('root element is missing');

const store = new Mock1Store('ABC-101');

installMockHarness({
  platform: PLATFORM_ID,
  specVersion: SPEC_VERSION,
  read: () => readState(store),
  reset: () => store.reset(),
});

mount(store, root);
document.title = PLATFORM_LABEL;
