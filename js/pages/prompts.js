// prompts.js — Prompt templates management
window.Pages = window.Pages || {};
window.Pages.prompts = {
  _builtinPrompts: [
    {
      id: 'sevastopol-battle',
      name: 'Sevastopol / Dramatic Conflict',
      category: 'Cossacks/Military',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the central dramatic conflict or most iconic moment of this story. Then depict that specific scene as a 19th-century military-grade oil painting: dense atmosphere, cannon smoke or dust, dramatic tension between figures, tattered fabric and raw human emotion. Muted palette of ochre, raw umber, gunmetal grey with flashes of blood-red. Thick, expressive brushwork in the tradition of Vasily Vereshchagin. The composition must be a circular vignette — the subject centred, fully contained within the circle, with soft atmospheric fade at the edges into empty space. No content touches the boundary.',
      negative_prompt: 'modern, cartoon, text, watermark, digital art, rectangular framing, content touching border, generic',
      style_profile: 'military'
    },
    {
      id: 'cossack-rider',
      name: 'Cossack / Epic Journey',
      category: 'Cossacks/Military',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the protagonist and the landscape or world central to this story. Then depict the protagonist in motion through that world — on horseback, on foot, or in flight — capturing the story\'s spirit of adventure or struggle. Paint it as a kinetic 19th-century oil painting with bold, gestural brushwork in the style of Ilya Repin. Warm earthy tones — burnt sienna, gold, slate blue — against a dramatic sky. The composition must be a circular vignette — the figure centred, fully contained within the circle, with atmospheric fade at the edges. No content touches the boundary.',
      negative_prompt: 'static, modern, cartoon, photographic, rectangular framing, content touching border, generic',
      style_profile: 'cavalry'
    },
    {
      id: 'romantic-golden-landscape',
      name: 'Golden Atmosphere',
      category: 'Classical Library',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the primary setting and emotional tone of this story. Then paint that specific landscape or environment bathed in luminous golden-hour light — whether it is a countryside, a city, a coastline, a garden, or an interior. Render it as a pastoral oil painting in the style of Corot and the Barbizon school: soft diffused natural light, warm greens and hazy golds, romantic realism. The composition must be a circular vignette — the scene centred, fully contained within the circle, with gentle atmospheric haze fading to empty space at the edges. No content touches the boundary.',
      negative_prompt: 'urban decay, modern, cold, cartoon, dark, rectangular framing, content touching border, generic',
      style_profile: 'landscape'
    },
    {
      id: 'moonlit-wilderness',
      name: 'Dark Romantic',
      category: 'Classical Library',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the deepest emotional undercurrent of this story — isolation, longing, mystery, or melancholy. Then depict a scene that embodies that mood: a solitary figure, an empty landscape, or a symbolic moment from the narrative, set under moonlight or twilight. Deep indigo, icy blue-white, and charcoal. Haunting beauty in the Romantic tradition of Caspar David Friedrich. The composition must be a circular vignette — the subject centred, fully contained within the circle, with dark edges dissolving naturally into empty space. No content touches the boundary.',
      negative_prompt: 'bright, sunny, cartoon, cheerful, rectangular framing, content touching border, generic',
      style_profile: 'nocturnal'
    },
    {
      id: 'river-idyll',
      name: 'Gentle Nostalgia',
      category: 'Classical Library',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the most peaceful, tender, or nostalgic moment in this story. Then paint that scene with warm intimacy — characters at rest, a quiet corner of their world, a moment of connection or reflection. Soft diffused light in warm greens, hazy golds, and gentle blue reflections, in the style of English Romantic landscape painters. The composition must be a circular vignette — the scene centred, fully contained within the circle, with edges fading softly into empty space. No content touches the boundary.',
      negative_prompt: 'violent, industrial, modern, stormy, cartoon, rectangular framing, content touching border, generic',
      style_profile: 'pastoral'
    },
    {
      id: 'art-nouveau-ornamental',
      name: 'Art Nouveau Symbolic',
      category: 'Wildcard',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the central symbol, theme, or iconic character of this story. Then render them as an Alphonse Mucha-inspired Art Nouveau composition: the figure or symbol framed by organic borders of flowing vines, flowers, and decorative elements that reflect the story\'s motifs. Muted jewel tones of sage green, dusty rose, antique gold, and deep teal. Elegant sinuous linework capturing the symbolic aesthetic of 1890s poster art. The composition must be a circular vignette — centred, fully contained within the circle, with ornamental elements fading at the edges. No content touches the boundary.',
      negative_prompt: 'photorealistic, modern, minimalist, harsh lines, rectangular framing, content touching border, generic',
      style_profile: 'nouveau'
    },
    {
      id: 'japanese-woodblock',
      name: 'Ukiyo-e Reimagining',
      category: 'Wildcard',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the most visually striking scene or environment in this story. Then reimagine it as a ukiyo-e woodblock print: bold black outlines defining flat areas of deep indigo, vermillion, and pale ochre. Translate the story\'s key moment into the spatial tension and pattern-making of Hiroshige and Hokusai — whether it depicts figures, nature, architecture, or weather. Fine parallel hatching in sky and water. The composition must be a circular vignette — centred, fully contained within the circle, with print-style edges dissolving into empty space. No content touches the boundary.',
      negative_prompt: 'photorealistic, western oil paint, gradient shading, rectangular framing, content touching border, generic',
      style_profile: 'woodblock'
    },
    {
      id: 'noir-silhouette',
      name: 'Noir Tension',
      category: 'Wildcard',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the moment of highest tension, danger, or moral ambiguity in this story. Then depict it as a high-contrast film noir composition: dramatic black-and-white with a single deep amber or crimson accent. Figures rendered as hard-edged silhouettes, shadows slicing across the scene, extreme chiaroscuro evoking 1940s crime fiction posters. The composition must be a circular vignette — centred, fully contained within the circle, with dark edges dissolving into empty space. No content touches the boundary.',
      negative_prompt: 'colour, pastel, bright, cheerful, busy, rectangular framing, content touching border, generic',
      style_profile: 'noir'
    },
    {
      id: 'botanical-engraving',
      name: 'Natural History Study',
      category: 'Wildcard',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify an animal, plant, object, or natural element that is central or symbolic to this story. Then render it as a vintage natural history engraving: exquisitely detailed scientific illustration with fine intaglio linework and delicate hand-applied watercolour washes of soft green, rose, and golden yellow. Meticulous stipple shading and hairline cross-hatching in the style of Redouté and Audubon. The composition must be a circular vignette — the specimen centred, fully contained within the circle, with fine linework fading at the edges into empty space. No content touches the boundary.',
      negative_prompt: 'photorealistic, modern, digital, bold, flat, cartoon, rectangular framing, content touching border, generic',
      style_profile: 'botanical'
    },
    {
      id: 'stained-glass-gothic',
      name: 'Gothic Stained Glass',
      category: 'Wildcard',
      template: 'Create a single illustration for the book "{title}" by {author}. First, identify the story\'s most transcendent, spiritual, or mythic moment. Then render it as a luminous stained glass window: rich jewel-toned panels of ruby red, cobalt blue, emerald green, and amber gold depicting the scene, separated by bold dark leading lines. Light streams through the glass creating a radiant, ethereal glow. Medieval Gothic cathedral aesthetic with intricate tracery patterns. The composition must be a circular rose window vignette — centred, fully contained within the circle, with decorative elements fading at the edges. No content touches the boundary.',
      negative_prompt: 'photorealistic, modern, muted, flat, cartoon, rectangular framing, content touching border, generic',
      style_profile: 'stained-glass'
    }
  ],

  async render() {
    const content = document.getElementById('content');
    const prompts = await DB.dbGetAll('prompts');

    content.innerHTML = `
      <div class="flex justify-between items-center mb-16">
        <div class="card-title">Prompt Templates</div>
        <div class="flex gap-8">
          <button class="btn btn-secondary btn-sm" id="seedBuiltins">Seed Built-in Prompts</button>
          <button class="btn btn-primary btn-sm" id="addPrompt">+ New Prompt</button>
        </div>
      </div>

      <div class="card mb-24">
        <div class="card-title mb-16">Template Previewer</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Book Title</label>
            <input class="form-input" id="previewTitle" value="Pride and Prejudice" placeholder="Enter a title...">
          </div>
          <div class="form-group">
            <label class="form-label">Author</label>
            <input class="form-input" id="previewAuthor" value="Jane Austen" placeholder="Enter author...">
          </div>
        </div>
        <div id="previewResult" class="text-sm text-muted" style="background:#f8fafc;padding:12px;border-radius:6px;margin-top:12px;display:none"></div>
      </div>

      ${prompts.length === 0 ? `
        <div class="empty-state">
          <h3>No prompts yet</h3>
          <p>Click "Seed Built-in Prompts" to load 10 starter templates, or create your own.</p>
        </div>
      ` : `
        <div class="grid-auto">
          ${prompts.map(p => `
            <div class="prompt-card" data-id="${p.id}">
              <div class="flex justify-between items-center">
                <h4>${p.name}</h4>
                <span class="tag tag-gold">${p.category}</span>
              </div>
              <p style="margin-top:6px">${p.template}</p>
              <div class="flex gap-8 mt-8">
                <button class="btn btn-sm btn-secondary edit-prompt" data-id="${p.id}">Edit</button>
                <button class="btn btn-sm btn-danger delete-prompt" data-id="${p.id}">Delete</button>
                <button class="btn btn-sm btn-secondary preview-prompt" data-id="${p.id}">Preview</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;

    this.bindEvents(prompts);
  },

  bindEvents(prompts) {
    document.getElementById('seedBuiltins').addEventListener('click', async () => {
      for (const p of this._builtinPrompts) {
        await DB.dbPut('prompts', { ...p, created_at: new Date().toISOString() });
      }
      Toast.success('Seeded 10 built-in prompts');
      this.render();
    });

    document.getElementById('addPrompt').addEventListener('click', () => this.showPromptEditor());

    document.querySelectorAll('.edit-prompt').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = prompts.find(x => x.id === parseInt(btn.dataset.id));
        if (p) this.showPromptEditor(p);
      });
    });
    document.querySelectorAll('.delete-prompt').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await DB.dbDelete('prompts', parseInt(btn.dataset.id));
        Toast.success('Prompt deleted');
        this.render();
      });
    });
    document.querySelectorAll('.preview-prompt').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = prompts.find(x => x.id === parseInt(btn.dataset.id));
        if (p) {
          const title = document.getElementById('previewTitle').value || '{title}';
          const author = document.getElementById('previewAuthor').value || '{author}';
          const resolved = p.template.replace(/\{title\}/g, title).replace(/\{author\}/g, author);
          const preview = document.getElementById('previewResult');
          preview.style.display = 'block';
          preview.textContent = resolved;
        }
      });
    });
  },

  showPromptEditor(existing = null) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${existing ? 'Edit' : 'New'} Prompt Template</div>
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" id="promptName" value="${existing?.name || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-select" id="promptCategory">
            <option value="style" ${existing?.category === 'style' ? 'selected' : ''}>Style</option>
            <option value="mood" ${existing?.category === 'mood' ? 'selected' : ''}>Mood</option>
            <option value="subject" ${existing?.category === 'subject' ? 'selected' : ''}>Subject</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Template (use {title} and {author} placeholders)</label>
          <textarea class="form-textarea" id="promptTemplate" rows="5">${existing?.template || ''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Negative prompt</label>
          <input class="form-input" id="promptNegative" value="${existing?.negative_prompt || ''}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="cancelPromptEdit">Cancel</button>
          <button class="btn btn-primary" id="savePromptEdit">Save</button>
        </div>
      </div>
    `;

    overlay.querySelector('#cancelPromptEdit').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#savePromptEdit').addEventListener('click', async () => {
      const data = {
        name: document.getElementById('promptName').value.trim(),
        category: document.getElementById('promptCategory').value,
        template: document.getElementById('promptTemplate').value.trim(),
        negative_prompt: document.getElementById('promptNegative').value.trim(),
        style_profile: '',
        created_at: existing?.created_at || new Date().toISOString()
      };
      if (existing?.id) data.id = existing.id;
      if (!data.name || !data.template) { Toast.warning('Name and template are required'); return; }
      await DB.dbPut('prompts', data);
      Toast.success('Prompt saved');
      overlay.remove();
      this.render();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
};