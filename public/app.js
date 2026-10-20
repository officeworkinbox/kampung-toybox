// Small progressive enhancements. Everything works without JavaScript.
document.addEventListener('DOMContentLoaded', () => {
  // Character counters for textareas with data-count.
  document.querySelectorAll('textarea[data-min], textarea[maxlength]').forEach((ta) => {
    const out = document.querySelector(`[data-counter-for="${ta.id}"]`);
    if (!out) return;
    const min = Number(ta.dataset.min || 0);
    const max = Number(ta.getAttribute('maxlength') || 0);
    const update = () => {
      const n = ta.value.trim().length;
      out.textContent = min && n < min ? `${min - n} more characters needed` : `${n}${max ? ' / ' + max : ''}`;
      out.style.color = min && n < min ? 'var(--coral-dark)' : '';
    };
    ta.addEventListener('input', update);
    update();
  });

  // Live photo previews on the upload form.
  const input = document.querySelector('input[type=file][data-preview]');
  if (input) {
    const box = document.getElementById(input.dataset.preview);
    input.addEventListener('change', () => {
      box.innerHTML = '';
      Array.from(input.files).slice(0, 4).forEach((f) => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.alt = f.name;
        box.appendChild(img);
      });
    });
  }

  // Gallery thumbnails.
  const main = document.querySelector('.gallery .main');
  document.querySelectorAll('.gallery .thumbs img').forEach((t) => {
    t.addEventListener('click', () => {
      main.src = t.src;
      document.querySelectorAll('.gallery .thumbs img').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    });
  });

  // Confirm destructive actions.
  document.querySelectorAll('form[data-confirm]').forEach((f) => {
    f.addEventListener('submit', (e) => { if (!window.confirm(f.dataset.confirm)) e.preventDefault(); });
  });
});
