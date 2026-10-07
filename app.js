/**
 * ==========================================================================
 * المرحلة الثالثة والأخيرة: المحرك التشغيلي المتكامل (app.js)
 * - استخراج نصوص PDF الضخمة بالدفعات (Batch Extraction) محلياً بدون تجميد المتصفح
 * - التكامل مع Google AI Studio REST API (gemini-3.8-flash و gemini-3.5-flash-lite)
 * - إدارة التخزين المحلي (localStorage)
 * - إدارة شاشات الواجهة، التلخيص، ومحاورة المستند
 * ==========================================================================
 */

// إعداد مسار الـ Worker الخاص بمكتبة PDF.js
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ثوابت التخزين والإعدادات
const STORAGE_KEYS = {
  API_KEY: 'mustanad_api_key',
  SELECTED_MODEL: 'mustanad_selected_model',
  SUMMARIES: 'mustanad_summaries_list'
};

// حالة التطبيق الراهنة (Application State)
const appState = {
  apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
  selectedModel: localStorage.getItem(STORAGE_KEYS.SELECTED_MODEL) || 'gemini-3.8-flash',
  summaries: JSON.parse(localStorage.getItem(STORAGE_KEYS.SUMMARIES) || '[]'),
  currentDoc: null, // المستند النشط حالياً في مساحة العمل
  chatHistory: []   // سجل المحادثة التفاعلية الحالية
};

// عناصر واجهة المستخدم (DOM Elements)
const DOM = {
  apiKeyInput: document.getElementById('api-key-input'),
  saveApiKeyBtn: document.getElementById('save-api-key-btn'),
  modelSelect: document.getElementById('model-select'),
  dashboardView: document.getElementById('dashboard-view'),
  workspaceView: document.getElementById('workspace-view'),
  triggerUploadBtn: document.getElementById('trigger-upload-btn'),
  pdfFileInput: document.getElementById('pdf-file-input'),
  cardsGrid: document.getElementById('cards-grid'),
  emptyState: document.getElementById('empty-state'),
  savedCountBadge: document.getElementById('saved-count-badge'),
  progressModal: document.getElementById('progress-modal'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  progressStatusTitle: document.getElementById('progress-status-title'),
  pageCounterText: document.getElementById('page-counter-text'),
  percentageText: document.getElementById('percentage-text'),
  backToDashboardBtn: document.getElementById('back-to-dashboard-btn'),
  workspaceDocTitle: document.getElementById('workspace-doc-title'),
  summaryContent: document.getElementById('summary-content'),
  copySummaryBtn: document.getElementById('copy-summary-btn'),
  downloadSummaryBtn: document.getElementById('download-summary-btn'),
  chatMessages: document.getElementById('chat-messages'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  sendChatBtn: document.getElementById('send-chat-btn')
};

// --------------------------------------------------------------------------
// 1. محرك استخراج النصوص بالدفعات (Batch PDF Extractor)
// --------------------------------------------------------------------------

/**
 * استخراج كامل نصوص مستند الـ PDF صفحة بصفحة بنظام المعالجة الدفعية
 * لتفادي استهلاك الذاكرة وتجميد واجهة المستخدم في الكتب الكبيرة
 */
async function extractTextFromPdf(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({
    data: arrayBuffer,
    disableAutoFetch: false,
    disableStream: false
  });

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const extractedPages = [];
  const BATCH_SIZE = 10; // حجم الدفعة لتحديث شريط التقدم وفسح المجال للمتصفح

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageStrings = textContent.items.map(item => item.str);
    const pageText = pageStrings.join(' ').trim();

    if (pageText.length > 0) {
      extractedPages.push(`--- [صفحة ${pageNum}] ---\n${pageText}`);
    }

    // إرسال تحديث التقدم الدوري
    if (pageNum % BATCH_SIZE === 0 || pageNum === numPages) {
      if (onProgress) {
        onProgress(pageNum, numPages);
      }
      // إعطاء فرصة لمحرك المتصفح لتحديث الـ DOM (Non-blocking yield)
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  return extractedPages.join('\n\n');
}

// --------------------------------------------------------------------------
// 2. محرك الاتصال بـ Google AI Studio REST API
// --------------------------------------------------------------------------

/**
 * إرسال طلب التوليد المباشر إلى Gemini REST API
 */
async function callGeminiApi({ model, apiKey, systemInstruction, contents }) {
  if (!apiKey) {
    throw new Error('يرجى إدخال وحفظ مفتاح Google AI Studio API أولاً للمتابعة.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: contents
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const message = errData.error?.message || `فشل الاتصال بالواجهة البرمجية (رمز الخطأ: ${response.status})`;
    throw new Error(message);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  const generatedText = candidate?.content?.parts?.[0]?.text;

  if (!generatedText) {
    throw new Error('لم يتم استلام نص مُولّد من النموذج. تأكد من سلامة المحتوى.');
  }

  return generatedText;
}

/**
 * إنشاء ملخص تنفيذي احترافي للنص الكامل المستخرج
 */
async function generateExecutiveSummary(documentText, docTitle) {
  const systemInstruction = 
    "أنت خبير محترف ومحلل أكاديمي في قراءة وتلخيص المراجع الضخمة والمستندات المعقدة. " +
    "مهمتك هي صياغة ملخص تنفيذي باللغة العربية بتنسيق Markdown متقن ومنظم، يشمل: " +
    "1. الفكرة الجوهرية والهدف الأساسي للمستند.\n" +
    "2. المحاور الرئيسية والمفاهيم المحورية (نقاط واضحة).\n" +
    "3. النتائج والاستنتاجات العملية والتوصيات المستخلصة.\n" +
    "اجعل الطرح متزناً، مباشراً، ومركزاً على القيمة دون حشو.";

  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `عنوان المستند: "${docTitle}"\n\nإليك كامل النص المستخرج من المستند:\n\n${documentText}`
        }
      ]
    }
  ];

  return await callGeminiApi({
    model: appState.selectedModel,
    apiKey: appState.apiKey,
    systemInstruction: systemInstruction,
    contents: contents
  });
}

/**
 * محاورة المستند مع الحفاظ على سياق النص والمحادثة
 */
async function sendDocumentChatMessage(userQuestion) {
  const systemInstruction = 
    "أنت مساعد بحثي ذكي مرتبط بسياق المستند المرفق بالكامل. " +
    "أجب بدقة ووضوح على أسئلة المستخدم مستنداً إلى محتوى المستند. " +
    "إذا طُلب منك إعادة صياغة أو تبسيط فكرة معينة، نفذ ذلك بأفضل أسلوب ممكن.";

  // تجهيز مصفوفة المحادثة وإدراج سياق المستند في أول رسالة
  const initialContextPrompt = 
    `سياق المستند بالكامل:\n"""\n${appState.currentDoc.fullText}\n"""\n\n` +
    `سؤال المستخدم الأول: ${appState.chatHistory[0]?.text || userQuestion}`;

  const apiContents = appState.chatHistory.map((item, index) => {
    let messageText = item.text;
    if (index === 0 && item.role === 'user') {
      messageText = initialContextPrompt;
    }
    return {
      role: item.role === 'user' ? 'user' : 'model',
      parts: [{ text: messageText }]
    };
  });

  return await callGeminiApi({
    model: appState.selectedModel,
    apiKey: appState.apiKey,
    systemInstruction: systemInstruction,
    contents: apiContents
  });
}

// --------------------------------------------------------------------------
// 3. إدارة التخزين المحلي والبيانات (Storage & Persistence)
// --------------------------------------------------------------------------

function saveSummariesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.SUMMARIES, JSON.stringify(appState.summaries));
  } catch (error) {
    console.warn('تجاوزت سعة التخزين المحلي، سيتم حفظ الملخصات بدون النص الكامل:', error);
    // في حال كبر حجم النصوص المخزنة، يتم تقليص النص الخام للمستندات الأقدم
    const trimmedSummaries = appState.summaries.map(item => ({
      ...item,
      fullText: item.id === appState.currentDoc?.id ? item.fullText : (item.fullText.slice(0, 1000) + '... [مقتطع لتوفير السعة]')
    }));
    localStorage.setItem(STORAGE_KEYS.SUMMARIES, JSON.stringify(trimmedSummaries));
  }
}

function saveNewSummaryRecord(record) {
  appState.summaries.unshift(record);
  saveSummariesToStorage();
  renderDashboardCards();
}

function deleteSummaryRecord(id) {
  if (confirm('هل أنت متأكد من رغبتك في حذف هذا الملخص نهائياً؟')) {
    appState.summaries = appState.summaries.filter(item => item.id !== id);
    saveSummariesToStorage();
    renderDashboardCards();
  }
}

// --------------------------------------------------------------------------
// 4. إدارة الواجهة وتجربة المستخدم (UI Management)
// --------------------------------------------------------------------------

function switchView(viewName) {
  if (viewName === 'workspace') {
    DOM.dashboardView.classList.add('hidden');
    DOM.workspaceView.classList.remove('hidden');
  } else {
    DOM.workspaceView.classList.add('hidden');
    DOM.dashboardView.classList.remove('hidden');
  }
}

function renderDashboardCards() {
  DOM.cardsGrid.innerHTML = '';
  const count = appState.summaries.length;
  DOM.savedCountBadge.textContent = `${count}${count === 1 ? 'ملخص' : 'ملخصات'}`;

  if (count === 0) {
    DOM.emptyState.classList.remove('hidden');
    return;
  }

  DOM.emptyState.classList.add('hidden');

  appState.summaries.forEach(item => {
    const card = document.createElement('div');
    card.className = 'summary-card';

    // تنظيف المقتطف من علامات الماركداون للعرض الأنيق
    const snippetText = item.summaryMarkdown.replace(/[#*`_>-]/g, '').trim();

    card.innerHTML = `
      <div>
        <h4 class="card-title" title="${item.title}">${item.title}</h4>
        <p class="card-snippet">${snippetText}</p>
      </div>
      <div class="card-footer">
        <span class="card-date">${item.date}</span>
        <div class="card-actions">
          <button class="btn btn-card-open" data-id="${item.id}">فتح مساحة العمل</button>
          <button class="btn btn-card-delete" data-id="${item.id}" title="حذف">حذف</button>
        </div>
      </div>
    `;

    card.querySelector('.btn-card-open').addEventListener('click', () => {
      openWorkspace(item);
    });

    card.querySelector('.btn-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSummaryRecord(item.id);
    });

    DOM.cardsGrid.appendChild(card);
  });
}

function openWorkspace(summaryRecord) {
  appState.currentDoc = summaryRecord;
  appState.chatHistory = []; // تصفير محادثة المستند القديمة

  DOM.workspaceDocTitle.textContent = summaryRecord.title;
  
  // تصيير الملخص بواسطة marked
  if (window.marked) {
    DOM.summaryContent.innerHTML = window.marked.parse(summaryRecord.summaryMarkdown);
  } else {
    DOM.summaryContent.textContent = summaryRecord.summaryMarkdown;
  }

  // إعادة ضبط نافذة الشات
  DOM.chatMessages.innerHTML = `
    <div class="chat-bubble ai">
      مرحباً بك! لقد استوعبت محتوى <strong>${summaryRecord.title}</strong> بالكامل. يمكنك طرح أي سؤال أو طلب تفصيل في أي فقرة.
    </div>
  `;

  switchView('workspace');
}

function appendChatBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  if (role === 'ai' && window.marked) {
    bubble.innerHTML = window.marked.parse(text);
  } else {
    bubble.textContent = text;
  }
  DOM.chatMessages.appendChild(bubble);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
  return bubble;
}

// --------------------------------------------------------------------------
// 5. إدارة الأحداث والتفاعلات (Event Listeners)
// --------------------------------------------------------------------------

// حفظ مفتاح الـ API
DOM.saveApiKeyBtn.addEventListener('click', () => {
  const key = DOM.apiKeyInput.value.trim();
  if (!key) {
    alert('يرجى إدخال مفتاح الـ API.');
    return;
  }
  appState.apiKey = key;
  localStorage.setItem(STORAGE_KEYS.API_KEY, key);
  DOM.saveApiKeyBtn.textContent = 'تم الحفظ ✓';
  setTimeout(() => {
    DOM.saveApiKeyBtn.textContent = 'حفظ المفتاح';
  }, 2000);
});

// تغيير النموذج
DOM.modelSelect.addEventListener('change', (e) => {
  appState.selectedModel = e.target.value;
  localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL, appState.selectedModel);
});

// رفع وتلخيص المستند
DOM.triggerUploadBtn.addEventListener('click', () => {
  if (!appState.apiKey) {
    alert('يرجى إدخال وحفظ مفتاح Google AI Studio API في الشريط العلوي أولاً.');
    DOM.apiKeyInput.focus();
    return;
  }
  DOM.pdfFileInput.click();
});

DOM.pdfFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // إظهار نافذة التقدم
  DOM.progressModal.classList.remove('hidden');
  DOM.progressStatusTitle.textContent = 'جاري استخراج نصوص المستند...';
  DOM.progressBarFill.style.width = '0%';
  DOM.percentageText.textContent = '0%';
  DOM.pageCounterText.textContent = 'بدء المعالجة...';

  try {
    // 1. استخراج النصوص صفحة بصفحة
    const fullExtractedText = await extractTextFromPdf(file, (currentPage, totalPages) => {
      const percentage = Math.round((currentPage / totalPages) * 100);
      DOM.progressBarFill.style.width = `${percentage}%`;
      DOM.percentageText.textContent = `${percentage}%`;
      DOM.pageCounterText.textContent = `معالجة الصفحة ${currentPage} من ${totalPages}`;
    });

    if (!fullExtractedText || fullExtractedText.trim().length === 0) {
      throw new Error('تعذر العثور على أي نصوص قابلة للقراءة داخل ملف الـ PDF.');
    }

    // 2. تحديث مؤشر الإرسال للذكاء الاصطناعي
    DOM.progressStatusTitle.textContent = 'جاري التلخيص بواسطة Gemini...';
    DOM.pageCounterText.textContent = `تم استخراج النصوص بالكامل، يتم بناء الملخص التنفيذي الآن...`;
    DOM.progressBarFill.style.width = '100%';

    // 3. الاتصال بـ Gemini لتوليد الملخص
    const docTitle = file.name.replace(/\.[^/.]+$/, '');
    const summaryMarkdown = await generateExecutiveSummary(fullExtractedText, docTitle);

    // 4. إنشاء وتخزين السجل الجديد
    const newRecord = {
      id: 'doc_' + Date.now(),
      title: docTitle,
      date: new Date().toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' }),
      summaryMarkdown: summaryMarkdown,
      fullText: fullExtractedText
    };

    saveNewSummaryRecord(newRecord);

    // 5. إغلاق النافذة والتوجه لمساحة العمل مباشرة
    DOM.progressModal.classList.add('hidden');
    openWorkspace(newRecord);

  } catch (error) {
    console.error('Extraction/Summary Error:', error);
    alert(`حدث خطأ أثناء المعالجة: ${error.message}`);
    DOM.progressModal.classList.add('hidden');
  } finally {
    DOM.pdfFileInput.value = ''; // تصفير حقل الرفع
  }
});

// العودة للرئيسية
DOM.back
