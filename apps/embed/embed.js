(function () {
  function createWidget(container) {
    const iframe = document.createElement("iframe");

    iframe.src = "https://jotd-project.pages.dev/?embedId=jotd";
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.overflow = "hidden";
    iframe.setAttribute("scrolling", "no");

    container.appendChild(iframe);

    window.addEventListener("message", function (event) {
      if (!event.data || event.data.type !== "jotd:resize") return;
      if (!event.data.height) return;

      iframe.style.height = event.data.height + "px";
    });
  }

  function init() {
    const containers = document.querySelectorAll("[data-jotd-embed]");
    containers.forEach(createWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
