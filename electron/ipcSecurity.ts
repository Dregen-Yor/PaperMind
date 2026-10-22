interface Frame { url: string }
interface Sender { mainFrame: Frame }
interface Invoke { sender: Sender; senderFrame: Frame | null }

export function isTrustedApplicationFrame(event: Invoke, applicationSenders: Sender[], expectedUrl: string): boolean {
  return applicationSenders.includes(event.sender) && event.senderFrame === event.sender.mainFrame
    && event.senderFrame !== null && event.senderFrame.url.split('#')[0] === expectedUrl.split('#')[0]
}
