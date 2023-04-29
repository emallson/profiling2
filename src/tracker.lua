---@type ProfilingNs
local ns = select(2, ...)

---@class TrackerNs
local trackerNs = {}


---The index of the current frame. managed by an `OnUpdate` script
local frameIndex = 0
local currentEncounter = nil
local currentMythicPlus = nil

function trackerNs.nextFrame()
  frameIndex = frameIndex + 1
end

function trackerNs.setEncounter(encounter)
  currentEncounter = encounter
end

function trackerNs.setMythicPlus(encounter)
  currentMythicPlus = encounter
end

function trackerNs.isEncounterInProgress()
  return currentEncounter ~= nil or currentMythicPlus ~= nil
end

---@return table|nil
function trackerNs.getCurrentEncounter()
  return currentMythicPlus or currentEncounter
end

---@return boolean
function trackerNs.isMythicPlusActive()
  return currentMythicPlus ~= nil
end

---Whether we are currently in a context that requires tracking. Generally false outside of raid/m+, true within.
local function trackingEnabled()
  return trackerNs.isEncounterInProgress()
end

---@class ScriptTracker
---@field public heap TinyMinHeap
---@field public moments MomentEstimator
---@field public quantiles QuantileEstimator
---@field public total_time number
---@field public commits number The number of frame values committed. Should be equal to the number of frames in which the tracked method was called.
---@field public reservoir ReservoirSampler
---@field private frame_time number The amount of time spent in the most recent frame
---@field private frame_calls number The amount of time it has been called this frame
---@field private lastIndex number The index of the last seen frame
local trackerBase = {}

function trackerBase:shouldCommit()
  return self.frame_time > 0 and self.lastIndex ~= frameIndex
end

function trackerBase:commit()
  self.moments:update(self.frame_time)
  self.heap:push(self.frame_time)
  self.quantiles:update(self.frame_time)
  self.reservoir:update(self.frame_time)
  self.total_time = self.total_time + self.frame_time
  self.total_calls = self.total_calls + self.frame_calls
  self.commits = self.commits + 1
  self.frame_calls = 0
  self.frame_time = 0
  self.lastIndex = frameIndex
end

---Record the amount of time taken for a single call of the method being tracked.
---@param call_time number
function trackerBase:record(call_time)
  if not trackingEnabled() then
    return
  end
  if self:shouldCommit() then
    self:commit()
  end
  self.frame_calls = self.frame_calls + 1
  self.frame_time = self.frame_time + call_time
end

function trackerBase:shouldExport()
  if self:shouldCommit() then
    self:commit()
  end
  return self.commits > 0
end

---Convert the tracker into a string-keyed table for storage
---@return table
function trackerBase:export()
  -- do a last check to see if we have uncommitted frame data
  if self:shouldCommit() then
    self:commit()
  end
  local stats = {
    mean = self.moments:mean(),
    quantiles = self.quantiles:quantiles(),
    samples = self.reservoir:samples(),
  }

  if self.moments:sample_count() >= 2 then
    stats.variance = self.moments:variance()
  end
  if self.moments:sample_count() >= 3 then
    stats.skew = self.moments:skewness()
  end

  return {
    commits = self.commits,
    calls = self.total_calls,
    total_time = self.total_time,
    stats = stats,
    top5 = self.heap:contents()
  }
end

function trackerBase:reset()
  self.commits = 0
  self.total_time = 0
  self.frame_time = 0
  self.total_calls = 0
  self.frame_calls = 0
  self.lastIndex = frameIndex
  self.moments:reset()
  self.quantiles:reset()
  self.reservoir:reset()
  self.heap:clear()
end

local trackerMeta = {
  __index = trackerBase
}

local trackers = {}

local function buildTracker()
  local tracker = {
    heap = ns.heap.new(5),
    moments = ns.moment_estimator.new(),
    quantiles = ns.quantile.new(),
    reservoir = ns.reservoir.new(200),
    total_time = 0,
    total_calls = 0,
    frame_time = 0,
    frame_calls = 0,
    commits = 0,
    lastIndex = frameIndex,
  }

  setmetatable(tracker, trackerMeta)

  return tracker
end

---Get a tracker. If no params provided, will be a new anonymous tracker.
---Otherwise, will be the tracker for the (frame, scriptType) combo, which 
---is re-used across SetScript calls.
---
---This may mean that you end up merging multiple different functions, but 
---we can't rely on function identity for sameness due to the common use ofs
---lambdas (which have distinct identities even for identical bodies).
---
---@param frame any|nil
---@param scriptType string|nil
---@return ScriptTracker
function trackerNs.getScriptTracker(frame, scriptType)
  if frame and trackers[frame] and trackers[frame][scriptType] then
    return trackers[frame][scriptType]
  end

  local tracker = buildTracker()

  if frame and scriptType then
    trackers[frame] = trackers[frame] or {}
    trackers[frame][scriptType] = tracker
  end

  return tracker
end

if type(ns) == 'table' then
  ns.tracker = trackerNs
end
