import {
  useCallback,
  useEffect,
  useRef,
  type UIEvent,
  type WheelEvent,
} from "react";

export function useBottomScroll(content: unknown, enabled = true) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const canResumeRef = useRef(true);
  const previousTopRef = useRef(0);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    // 嵌套思考框的滚动不应改变外层聊天区的跟随状态。
    if (event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    const top = element.scrollTop;
    if (top < previousTopRef.current) {
      followingRef.current = false;
    } else if (
      top > previousTopRef.current &&
      canResumeRef.current &&
      element.scrollHeight - element.clientHeight - top <= 1
    ) {
      followingRef.current = true;
    }
    previousTopRef.current = top;
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

  useEffect(() => {
    if (!enabled || !followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element || !followingRef.current) return;
      element.scrollTop = element.scrollHeight;
      previousTopRef.current = element.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [content, enabled]);

  return {
    scrollRef,
    onScroll,
    onWheelCapture,
    onPointerDownCapture: allowScrollResume,
    onKeyDownCapture: allowScrollResume,
  };
}
