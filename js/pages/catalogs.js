// catalogs.js — Full book catalog from Drive
window.Pages = window.Pages || {};
window.Pages.catalogs = {
  _search: '',

  async render() {
    const content = document.getElementById('content');
    let books = await DB.dbGetAll('books');

    books.sort((a, b) => (a.number || '').localeCompare(b.number || '', undefined, { numeric: true }));

    if (this._search) {
      const q = this._search.toLowerCase();
      books = books.filter(b => 
        b.title.toLowerCase().includes(q) || 
        (b.author || '').toLowerCase().includes(q) ||
        b.folder_name.toLowerCase().includes(q)
      );
    }

    const apiKey = await DB.getSetting('google_api_key');

    content.innerHTML = `
      <div class="flex justify-between items-center mb-16">
        <div class="card-title">${books.length} Books in Catalog</div>
        <div class="flex gap-8">
          <input class="form-input" style="width:240px" placeholder="Search books..." id="catalogSearch" value="${this._search}">
          <button class="btn btn-primary btn-sm" id="syncFromDrive">Sync from Drive</button>
        </div>
      </div>

      ${books.length === 0 && !this._search ? `
        <div class="empty-state">
          <h3>No books in catalog</h3>
          <p>Click "Sync from Drive" to fetch your book collection</p>
        </div>
      ` : books.length === 0 ? `
        <div class="empty-state">
          <h3>No matches</h3>
          <p>Try a different search term</p>
        </div>
      ` : `
        <div class="grid-auto" id="catalogGrid">
          ${books.map(book => {
            const thumbUrl = book.cover_jpg_id 
              ? Drive.getDriveThumbnailUrl(book.cover_jpg_id, apiKey, 280)
              : '';
            return `
              <div class="book-card" data-book-id="${book.id}">
                <div class="book-thumb">
                  ${thumbUrl 
                    ? `<img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.parentElement.innerHTML='📖'">`
                    : '<span>📖</span>'}
                </div>
                <div class="book-info">
                  <div class="book-title">${book.title}</div>
                  <div class="book-author">${book.author || '—'}</div>
                  <div class="text-xs text-muted mt-8">${book.number ? '#' + book.number + ' · ' : ''}${book.folder_name}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    `;

    document.getElementById('catalogSearch').addEventListener('input', (e) => {
      this._search = e.target.value;
      clearTimeout(this._searchTimeout);
      this._searchTimeout = setTimeout(() => this.render(), 300);
    });

    document.getElementById('syncFromDrive').addEventListener('click', async () => {
      try {
        Toast.info('Syncing catalog from Google Drive...');
        const newBooks = await Drive.syncCatalog();
        Toast.success(`Synced ${newBooks.length} books`);
        this.render();
      } catch (e) {
        Toast.error(`Sync failed: ${e.message}`);
      }
    });

    document.querySelectorAll('.book-card').forEach(card => {
      card.addEventListener('click', () => this.showBookDetail(card.dataset.bookId));
    });
  },

  async showBookDetail(bookId) {
    const book = await DB.dbGet('books', bookId);
    if (!book) return;
    const apiKey = await DB.getSetting('google_api_key');
    const jobs = await DB.dbGetByIndex('jobs', 'book_id', bookId);
    const winner = await DB.dbGet('winners', bookId);

    const thumbUrl = book.cover_jpg_id ? Drive.getDriveThumbnailUrl(book.cover_jpg_id, apiKey, 400) : '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:600px">
        <div class="modal-title">${book.title}</div>
        <div class="grid-2" style="gap:20px">
          <div>
            ${thumbUrl ? `<img src="${thumbUrl}" style="width:100%;border-radius:8px" onerror="this.style.display='none'">` : ''}
          </div>
          <div>
            <div class="form-group"><span class="form-label">Author</span><p>${book.author || '—'}</p></div>
            <div class="form-group"><span class="form-label">Number</span><p>${book.number || '—'}</p></div>
            <div class="form-group"><span class="form-label">Folder</span><p class="text-sm">${book.folder_name}</p></div>
            <div class="form-group"><span class="form-label">Cover File</span><p class="text-sm">${book.cover_file_name || '—'}</p></div>
            <div class="form-group"><span class="form-label">Synced</span><p class="text-sm">${formatDate(book.synced_at)}</p></div>
            <div class="form-group"><span class="form-label">Variants</span><p>${jobs.filter(j => j.status === 'completed').length} completed, ${jobs.filter(j => j.status === 'failed').length} failed</p></div>
            ${winner ? '<span class="tag tag-status">Approved</span>' : ''}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
          <a href="#iterate" class="btn btn-primary" onclick="document.getElementById('bookSelect')&&(document.getElementById('bookSelect').value='${book.id}');this.closest('.modal-overlay').remove()">Generate</a>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }
};