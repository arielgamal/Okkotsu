chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'download') {
    // Blob/URL.createObjectURL não funciona em service workers (MV3)
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(message.content);
    chrome.downloads.download({
      url: dataUrl,
      filename: message.filename,
      saveAs: true,
    });
  }
});
