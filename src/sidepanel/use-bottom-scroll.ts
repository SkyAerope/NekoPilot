import {
  useCallback,
  useLayoutEffect,
  useRef,
  type UIEvent,
  type WheelEvent,
} from "react";

export function useBottomScroll(content: unknown, enabled = true) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const canResumeRef = useRef(true);
  const previousTopRef = useRef(0);
  const previousBottomRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !followingRef.current) return;
    const bottom = element.scrollHeight - element.clientHeight;
    if (bottom - element.scrollTop > 1) element.scrollTop = bottom;
    previousTopRef.current = element.scrollTop;
    previousBottomRef.current = bottom;
  }, []);

  const resumeFollowing = useCallback(() => {
    followingRef.current = true;
    canResumeRef.current = true;
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    // 嵌套思考框的滚动不应改变外层聊天区的跟随状态。
    if (event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    const top = element.scrollTop;
    const bottom = element.scrollHeight - element.clientHeight;
    // 内容或视口缩放也会降低 scrollTop，此时由尺寸观察器重新贴底。
    if (
      top < previousTopRef.current &&
      bottom === previousBottomRef.current &&
      bottom - top > 1
    ) {
      followingRef.current = false;
    } else if (
      top > previousTopRef.current &&
      canResumeRef.current &&
      bottom - top <= 1
    ) {
      followingRef.current = true;
    }
    previousTopRef.current = top;
    previousBottomRef.current = bottom;
  }, []);

  const onWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    let target = event.target instanceof Element ? event.target : null;
    while (target && target !== event.currentTarget) {
      // 内层能消费滚轮时只改变内层状态，避免外层误判滚动意图。
      if (
        (event.deltaY < 0
          ? target.scrollTop > 0
          : target.scrollHeight - target.clientHeight - target.scrollTop > 1) &&
        /^(auto|scroll)$/.test(getComputedStyle(target).overflowY)
      )
        return;
      target = target.parentElement;
    }
    const element = event.currentTarget;
    canResumeRef.current = event.deltaY > 0;
    if (event.deltaY < 0) {
      // 暂停状态持续到新的向下操作，延迟滚动事件不能重新开启跟随。
      followingRef.current = false;
    } else if (
      element.scrollHeight - element.clientHeight - element.scrollTop <=
      1
    ) {
      followingRef.current = true;
    }
  }, []);

  const allowScrollResume = useCallback(() => {
    // 用户改用键盘或拖动滚动条时，允许滚到底部后恢复跟随。
    canResumeRef.current = true;
  }, []);

  useLayoutEffect(() => {
    if (enabled) scrollToBottom();
  }, [content, enabled, scrollToBottom]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const contentElement = contentRef.current;
    if (!enabled || !scroller || !contentElement) return;
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(scroller);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [enabled, scrollToBottom]);

  return {
    scrollRef,
    contentRef,
    resumeFollowing,
    onScroll,
    onWheelCapture,
    onPointerDownCapture: allowScrollResume,
    onKeyDownCapture: allowScrollResume,
  };
}
