---@type ProfilingNs
local ns = select(2, ...)

---@class TrackerNs
local trackerNs = {
  DependentType = {
    Dependent = true,
    Independent = false,
  }
}


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
---@field private sketch Sketch
---@field public total_time number
---@field public commits number The number of frame values committed. Should be equal to the number of frames in which the tracked method was called.
---@field private frame_time number The amount of time spent in the most recent frame
---@field private frame_calls number The amount of time it has been called this frame
---@field private lastIndex number The index of the last seen frame
---@field private dependent? boolean
local trackerBase = {}

function trackerBase:shouldCommit()
  return self.frame_time > 0 and self.lastIndex ~= frameIndex
end

function trackerBase:commit()
  self.sketch:push(self.frame_time)
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

  return {
    commits = self.commits,
    calls = self.total_calls,
    total_time = self.total_time,
    sketch = self.sketch:export(),
    dependent = self.dependent or false
  }
end

function trackerBase:reset()
  self.commits = 0
  self.total_time = 0
  self.frame_time = 0
  self.total_calls = 0
  self.frame_calls = 0
  self.lastIndex = frameIndex
  self.sketch:reset()
end

local trackerMeta = {
  __index = trackerBase
}

local trackers = {}

local function buildTracker()
  local tracker = {
    sketch = ns.sketch.new(),
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
function trackerNs.getFrameScriptTracker(frame, scriptType)
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

---Get an anonymous script tracker. If the script may be called as a result of another script, it should be
---marked as dependent
---@param dependent? boolean
function trackerNs.getScriptTracker(dependent)
  local tracker = buildTracker()
  tracker.dependent = dependent
  return tracker
end

if type(ns) == 'table' then
  ns.tracker = trackerNs
end
