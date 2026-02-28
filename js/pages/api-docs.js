// api-docs.js — Reference page for internal API/data methods
window.Pages = window.Pages || {};
window.Pages['api-docs'] = {
  async render() {
    const content = document.getElementById('content');

    content.innerHTML = `
      <div class="card">
        <div class="card-title mb-16">API Reference — Internal Methods</div>
        <p class="text-sm text-muted mb-24">Reference documentation for all internal modules. Useful for debugging and development.</p>

        <div class="tabs mb-16">
          <button class="tab active" data-tab="db">Database</button>
          <button class="tab" data-tab="drive">Drive API</button>
          <button class="tab" data-tab="openrouter">OpenRouter</button>
          <button class="tab" data-tab="compositor">Compositor</button>
          <button class="tab" data-tab="quality">Quality</button>
          <button class="tab" data-tab="queue">Job Queue</button>
        </div>

        <div id="apiDocContent"></div>
      </div>
    `;

    const tabs = {
      db: this.renderDB,
      drive: this.renderDrive,
      openrouter: this.renderOpenRouter,
      compositor: this.renderCompositor,
      quality: this.renderQuality,
      queue: this.renderQueue,
    };

    const renderTab = (name) => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.getElementById('apiDocContent').innerHTML = tabs[name]();
    };

    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => renderTab(t.dataset.tab));
    });

    renderTab('db');
  },

  renderDB() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.DB — IndexedDB Wrapper</h3>
      
      <div class="mb-16">
        <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">Object Stores</h4>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Store</th><th>Key</th><th>Indexes</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code class="code-inline">books</code></td><td>id</td><td>folder_name</td><td>Synced book catalog from Drive</td></tr>
              <tr><td><code class="code-inline">jobs</code></td><td>id</td><td>book_id, status, created_at, model</td><td>Generation jobs (queued, running, completed, failed)</td></tr>
              <tr><td><code class="code-inline">winners</code></td><td>book_id</td><td>—</td><td>Approved variant per book</td></tr>
              <tr><td><code class="code-inline">prompts</code></td><td>id (auto)</td><td>category</td><td>Prompt templates</td></tr>
              <tr><td><code class="code-inline">settings</code></td><td>key</td><td>—</td><td>Key-value settings</td></tr>
              <tr><td><code class="code-inline">cost_ledger</code></td><td>id (auto)</td><td>recorded_at, model, job_id</td><td>Cost tracking entries</td></tr>
              <tr><td><code class="code-inline">batches</code></td><td>id</td><td>—</td><td>Batch run records</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="mb-16">
        <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">Methods</h4>
        <div class="code-block">DB.openDB()                        → Promise&lt;IDBDatabase&gt;
DB.dbPut(storeName, item)          → Promise&lt;key&gt;
DB.dbGet(storeName, key)           → Promise&lt;item|undefined&gt;
DB.dbGetAll(storeName)             → Promise&lt;item[]&gt;
DB.dbDelete(storeName, key)        → Promise&lt;void&gt;
DB.dbClear(storeName)              → Promise&lt;void&gt;
DB.dbGetByIndex(store, idx, val)   → Promise&lt;item[]&gt;
DB.dbCount(storeName)              → Promise&lt;number&gt;
DB.getSetting(key, default)        → Promise&lt;value&gt;
DB.setSetting(key, value)          → Promise&lt;void&gt;
DB.initDefaults()                  → Promise&lt;void&gt;</div>
      </div>
    `;
  },

  renderDrive() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.Drive — Google Drive API</h3>
      <div class="code-block">// List subfolders in a Drive folder
Drive.listDriveSubfolders(folderId, apiKey)  → Promise&lt;{id, name}[]&gt;

// List files in a subfolder
Drive.listDriveFiles(folderId, apiKey)       → Promise&lt;{id, name, mimeType, size}[]&gt;

// Get direct download URL for a file
Drive.getDriveDownloadUrl(fileId, apiKey)     → string

// Get thumbnail URL
Drive.getDriveThumbnailUrl(fileId, apiKey, size=220) → string

// Parse folder name "001 - Title by Author"
Drive.parseBookFolder(name)                   → {number, title, author}

// Sync all books from Drive to IndexedDB
Drive.syncCatalog()                           → Promise&lt;book[]&gt;

// Download cover as Image element
Drive.downloadCoverAsImage(fileId, apiKey)    → Promise&lt;HTMLImageElement&gt;

// Download cover as Blob
Drive.downloadCoverAsBlob(fileId, apiKey)     → Promise&lt;Blob&gt;</div>

      <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">Book Schema</h4>
      <div class="code-block">{
  id: "folder_id",      // Google Drive folder ID
  number: "001",        // Book number (from folder name)
  title: "Pride ...",   // Book title
  author: "Jane ...",   // Author name
  folder_name: "001 - Pride and Prejudice by Jane Austen",
  cover_jpg_id: "file_id",  // Drive file ID for cover JPG
  synced_at: "ISO date"
}</div>
    `;
  },

  renderOpenRouter() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.OpenRouter — Image Generation</h3>
      
      <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">Available Models</h4>
      <div class="table-wrap mb-16">
        <table>
          <thead><tr><th>Key</th><th>API Model ID</th><th>Cost/Image</th></tr></thead>
          <tbody>
            <tr><td><code class="code-inline">nano-banana</code></td><td>google/gemini-2.5-flash-image</td><td>$0.003</td></tr>
            <tr><td><code class="code-inline">nano-banana-2</code></td><td>google/gemini-3.1-flash-image-preview</td><td>$0.006</td></tr>
            <tr><td><code class="code-inline">nano-banana-pro</code></td><td>google/gemini-3-pro-image-preview</td><td>$0.010</td></tr>
            <tr><td><code class="code-inline">gpt-5-image-mini</code></td><td>openai/gpt-5-image-mini</td><td>$0.012</td></tr>
            <tr><td><code class="code-inline">gpt-5-image</code></td><td>openai/gpt-5-image</td><td>$0.040</td></tr>
          </tbody>
        </table>
      </div>

      <div class="code-block">// Generate an image
OpenRouter.generateImage(prompt, modelId, apiKey) → Promise&lt;response&gt;

// Extract data URL from response
OpenRouter.extractImageFromResponse(data)         → string|null

// Convert data URL to Blob
OpenRouter.dataUrlToBlob(dataUrl)                 → Blob

// Convert Blob to data URL
OpenRouter.blobToDataUrl(blob)                    → Promise&lt;string&gt;

// Load image from blob or URL
OpenRouter.loadImage(src)                         → Promise&lt;HTMLImageElement&gt;</div>
    `;
  },

  renderCompositor() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.Compositor — Canvas Compositing</h3>
      <div class="code-block">// Composite generated image as circular medallion onto cover
Compositor.compositeOnCover(
  coverImg,        // HTMLImageElement of cover (3784×2777)
  generatedImg,    // HTMLImageElement of AI-generated illustration
  cx = 2850,       // Medallion center X
  cy = 1350,       // Medallion center Y
  radius = 520,    // Medallion radius
  feather = 15     // Edge feather in pixels
) → HTMLCanvasElement

// Create a scaled-down thumbnail
Compositor.createThumbnail(canvas, maxWidth=400) → HTMLCanvasElement

// Convert canvas to Blob
Compositor.canvasToBlob(canvas, type, quality)   → Promise&lt;Blob&gt;

// Convert canvas to data URL
Compositor.canvasToDataUrl(canvas, type, quality) → string</div>

      <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">Cover Layout</h4>
      <p class="text-sm text-muted">Covers are 3784×2777px wraparound (back + spine + front). The medallion goes on the front panel, default center at (2850, 1350) with radius 520px.</p>
    `;
  },

  renderQuality() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.Quality — Quality Scoring</h3>
      <div class="code-block">// Score a canvas (0.0 to 1.0)
Quality.scoreImage(canvas)                  → number

// Score a generated image element
Quality.scoreGeneratedImage(imageElement)   → number</div>

      <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">Scoring Factors</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Factor</th><th>Weight</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td>Color Variance</td><td>35%</td><td>Not all one color; good images have high RGB variance</td></tr>
            <tr><td>Brightness</td><td>25%</td><td>Optimal around 45% brightness; not too dark or bright</td></tr>
            <tr><td>Contrast</td><td>25%</td><td>Standard deviation of brightness values</td></tr>
            <tr><td>Color Diversity</td><td>15%</td><td>Spread between R, G, B channel averages</td></tr>
          </tbody>
        </table>
      </div>
    `;
  },

  renderQueue() {
    return `
      <h3 style="font-size:14px;font-weight:700;margin-bottom:12px">window.JobQueue — Sequential Job Processor</h3>
      <div class="code-block">// Add a single job
JobQueue.add(job)                → void

// Add multiple jobs
JobQueue.addBatch(jobs)          → void

// Pause/Resume
JobQueue.pause()                 → void
JobQueue.resume()                → void

// Cancel specific job or all
JobQueue.cancel(jobId)           → void
JobQueue.cancelAll()             → void

// Listen for state changes
JobQueue.onChange(callback)      → void

// Properties
JobQueue.queue                   → Job[]
JobQueue.running                 → boolean
JobQueue.paused                  → boolean
JobQueue.currentJob              → Job|null</div>

      <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">Job Status Flow</h4>
      <p class="text-sm text-muted">queued → downloading_cover → generating → compositing → scoring → completed (or failed)</p>

      <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">Job Schema</h4>
      <div class="code-block">{
  id: "uuid",
  book_id: "drive_folder_id",
  model: "nano-banana",
  variant: 1,
  status: "queued",
  prompt: "...",
  quality_score: 0.72,
  cost_usd: 0.003,
  generated_image_blob: Blob,
  composited_image_blob: Blob,
  started_at: "ISO",
  completed_at: "ISO",
  error: null,
  results_json: "...",
  created_at: "ISO"
}</div>
    `;
  }
};