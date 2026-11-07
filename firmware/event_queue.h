// Fall events waiting to reach the server (docs/PROTOCOL.md 2.2: queue in RAM, retry until
// a 200, lost on reboot). Fixed size; when full, the oldest event is dropped and counted.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "config.h"
#include "fall_detector.h"

class EventQueue {
 public:
  // Returns false if the queue was full and the oldest event was dropped to make room.
  bool push(const FallEvent& e);
  bool empty() const { return count_ == 0; }
  size_t size() const { return count_; }
  const FallEvent& front() const { return items_[head_]; }  // only when not empty
  void pop();
  uint32_t dropped() const { return dropped_; }

 private:
  FallEvent items_[EVENT_QUEUE_SIZE] = {};
  size_t head_ = 0;
  size_t count_ = 0;
  uint32_t dropped_ = 0;
};
