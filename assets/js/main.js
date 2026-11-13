// Mobile menu
const btn = document.querySelector('.menu-btn');
const nav = document.querySelector('.nav');
if (btn && nav) {
  btn.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
  const close = () => {
    nav.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      close();
      btn.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target) && !btn.contains(e.target)) close();
  });
}

// Header border on scroll + reading progress bar on articles
const header = document.querySelector('.site-header');
let bar = null;
if (document.querySelector('article.article')) {
  bar = document.createElement('div');
  bar.className = 'progress';
  document.body.appendChild(bar);
}
const onScroll = () => {
  if (header) header.classList.toggle('scrolled', window.scrollY > 8);
  if (bar) {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(window.scrollY / max, 1) : 0})`;
  }
};
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Reveal sections as they scroll into view
const targets = document.querySelectorAll('.section-head, .card, .case, .cta .wrap, .box');
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      io.unobserve(el);
      el.classList.add('in');
      // Drop the classes afterwards so hover transitions go back to normal
      setTimeout(() => el.classList.remove('reveal', 'in'), 1300);
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  targets.forEach((el) => {
    if (el.classList.contains('card')) {
      const i = Array.prototype.indexOf.call(el.parentElement.children, el);
      el.style.setProperty('--d', `${i * 90}ms`);
    }
    el.classList.add('reveal');
    io.observe(el);
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
