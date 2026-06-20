async function apiGet(path) {
  const response = await fetch(path);
  return response.json();
}

const button = document.getElementById("loadStateButton");
const preview = document.getElementById("statePreview");
const hint = document.getElementById("statusHint");

button?.addEventListener("click", async () => {
  hint.textContent = "请求中...";
  try {
    const result = await apiGet("/api/state");
    preview.textContent = JSON.stringify(result, null, 2);
    hint.textContent = result.code === 200 ? "请求成功" : result.message;
  } catch (error) {
    preview.textContent = String(error);
    hint.textContent = "请求失败";
  }
});
