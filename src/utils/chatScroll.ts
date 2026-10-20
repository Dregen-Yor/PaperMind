import { nextTick, ref, type Ref } from 'vue'

/** Follow new output until the reader deliberately moves away from the bottom. */
export function useChatScroll(element: Ref<HTMLElement | undefined>) {
  const following = ref(true)
  function onScroll() {
    const target = element.value
    if (target) following.value = target.scrollHeight - target.clientHeight - target.scrollTop <= 64
  }
  async function scrollToBottom(force = false) {
    if (force) following.value = true
    if (!following.value) return
    await nextTick()
    if (following.value && element.value) element.value.scrollTop = element.value.scrollHeight
  }
  return { following, onScroll, scrollToBottom }
}
