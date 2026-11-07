#include "event_queue.h"

bool EventQueue::push(const FallEvent& e) {
  bool kept_all = true;
  if (count_ == EVENT_QUEUE_SIZE) {
    pop();
    dropped_++;
    kept_all = false;
  }
  items_[(head_ + count_) % EVENT_QUEUE_SIZE] = e;
  count_++;
  return kept_all;
}

void EventQueue::pop() {
  if (count_ == 0) return;
  head_ = (head_ + 1) % EVENT_QUEUE_SIZE;
  count_--;
}
