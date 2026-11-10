// Mobile menu
const btn = document.querySelector('.menu-btn');
const nav = document.querySelector('.nav');
if (btn && nav) {
  btn.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
}

// "Copy" buttons on prompt boxes
document.querySelectorAll('.prompt').forEach((box) => {
  const b = document.createElement('button');
  b.className = 'copy';
  b.type = 'button';
  b.textContent = 'Copy';
  b.addEventListener('click', async () => {
    const text = box.querySelector('.text').innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied ✓';
    } catch {
      b.textContent = 'Select & copy';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1800);
  });
  box.appendChild(b);
});
