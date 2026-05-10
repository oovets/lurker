import { ref, onMounted, onBeforeUnmount } from 'vue';

// Mobile breakpoint. The desktop layout is a 220 + 1fr + 180 = 400px-of-chrome
// grid, so anything below ~720px gets squeezed beyond repair. 768px is a
// conventional tablet-portrait threshold and gives a comfortable margin.
const MOBILE_QUERY = '(max-width: 768px)';

// One shared MediaQueryList — cheaper than per-component listeners and means
// every consumer flips at the exact same moment when the viewport crosses
// the breakpoint.
let mql = null;
const isMobile = ref(false);
let initialized = false;

function ensureInit() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;
  // addEventListener is the modern path; older Safari needs addListener.
  if (mql.addEventListener) mql.addEventListener('change', onChange);
  else mql.addListener(onChange);
}

function onChange(e) {
  isMobile.value = e.matches;
}

export function useViewport() {
  ensureInit();
  return { isMobile };
}

// visualViewport tracks the actual visible area, which on iOS Safari shrinks
// when the soft keyboard opens. We write both:
//
//   --viewport-h: visible height. Lets the mobile shell shrink so the input
//   ends up just above the keyboard instead of below it.
//
//   --viewport-y: how far the visual viewport has been pushed down inside
//   the layout viewport. When the user focuses an input, iOS Safari scrolls
//   the layout viewport upward to keep the input visible — for a fixed-
//   position element that would mean it scrolls offscreen with the page.
//   translateY-ing the shell by --viewport-y undoes that auto-scroll so the
//   shell stays glued to the actual visible area.
//
// Together with position: fixed on .mchat, these defeat the iOS quirk where
// focusing an input pushes the whole app up and leaves a gray gutter below.
export function useVisualViewportHeight() {
  const installed = ref(false);
  function update() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const y = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty('--viewport-h', `${h}px`);
    document.documentElement.style.setProperty('--viewport-y', `${y}px`);
  }
  onMounted(() => {
    if (typeof window === 'undefined') return;
    update();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', update);
      window.visualViewport.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    installed.value = true;
  });
  onBeforeUnmount(() => {
    if (typeof window === 'undefined') return;
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', update);
      window.visualViewport.removeEventListener('scroll', update);
    }
    window.removeEventListener('resize', update);
  });
  return { installed };
}
