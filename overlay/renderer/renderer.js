const stage = document.getElementById('stage');
const clippyEl = document.getElementById('clippy');
const bubble = document.getElementById('bubble');
const lineEl = document.getElementById('line');

const ANIMATIONS = ['idle', 'wave', 'think', 'alert', 'celebrate', 'sad'];
const NOTICE_MS = 9000;
let noticeTimer;

function play(animation) {
  clippyEl.classList.remove(...ANIMATIONS);
  void clippyEl.offsetWidth; // restart the CSS animation even if the class repeats
  clippyEl.classList.add(ANIMATIONS.includes(animation) ? animation : 'idle');
}

// One-shot animations fall back to the idle bob when they finish.
clippyEl.addEventListener('animationend', (e) => {
  if (e.target === clippyEl && !clippyEl.classList.contains('idle')) play('idle');
});

function showBubble(text, { question }) {
  clearTimeout(noticeTimer);
  lineEl.textContent = text;
  bubble.classList.toggle('question', question);
  bubble.classList.remove('hidden');
}

function hideBubble() {
  clearTimeout(noticeTimer);
  bubble.classList.add('hidden');
}

window.clippy.onOffer(({ message, animation }) => {
  showBubble(message, { question: true });
  play(animation);
});

window.clippy.onExpire(hideBubble);

window.clippy.onNotice((text) => {
  showBubble(text, { question: false });
  play('alert');
  noticeTimer = setTimeout(hideBubble, NOTICE_MS);
});

window.clippy.onLeave(() => {
  hideBubble();
  stage.classList.add('gone');
  window.clippy.setHover(false); // nothing left to click on
});

window.clippy.onReturn(() => {
  stage.classList.remove('gone');
  play('wave');
});

function answer(choice) {
  hideBubble();
  play(choice === 'yes' ? 'celebrate' : 'sad');
  window.clippy.answer(choice);
}
document.getElementById('yes').addEventListener('click', () => answer('yes'));
document.getElementById('no').addEventListener('click', () => answer('no'));

// The window ignores the mouse except while the pointer is over Clippy or the bubble.
for (const el of document.querySelectorAll('.hit')) {
  el.addEventListener('mouseenter', () => window.clippy.setHover(true));
  el.addEventListener('mouseleave', () => window.clippy.setHover(false));
}
