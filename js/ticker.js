/* ticker.js: background clock for the Simulate tab.
 * Browsers pause requestAnimationFrame and slow down timers in hidden tabs,
 * but a dedicated worker keeps its own timer and its messages still reach
 * the page, so the simulation can keep stepping while the tab is hidden. */
let iv = null;
onmessage = (e) => {
  if (e.data === 'start' && !iv) iv = setInterval(() => postMessage(0), 50);
  else if (e.data === 'stop' && iv) { clearInterval(iv); iv = null; }
};
