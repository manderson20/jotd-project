export default {
  async fetch() {
    return new Response("OK - module worker", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
