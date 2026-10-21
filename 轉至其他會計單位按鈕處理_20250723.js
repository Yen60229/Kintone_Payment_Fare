function adjustTransferButtonsPosition() {
  // 延遲執行以確保按鈕已經渲染
  setTimeout(() => {
    // 找到所有動作按鈕的 span 標籤
    const actionLabels = document.querySelectorAll('.gaia-app-statusbar-action-label');

    actionLabels.forEach((span) => {
      const buttonText = span.textContent || span.innerText;

      // 檢查是否為「轉至」開頭的按鈕
      if (buttonText.startsWith('轉至')) {
        // 找到 span 的父元素（應該是 button）
        const button = span.closest('button') || span.parentElement;

        if (button) {
          // 往右移動按鈕
          button.style.marginLeft = '30px';
        }
      }
    });

    console.log('已調整轉至按鈕位置');
  }, 500);
}

kintone.events.on(['app.record.detail.show'], (event) => {
  adjustTransferButtonsPosition();
  return event;
});
