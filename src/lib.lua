---@class ProfilingNs
---@field public heap HeapNs
---@field public moment_estimator MomentEstimatorNs
---@field public quantile QuantileNs

---@type ProfilingNs
local ns = select(2, ...)
local profiling2 = {}

---@param frameName string
---@param origParent Frame|ParentedObject
---@return string
function profiling2.buildFrameKey(frameName, origParent)
  local parent = origParent

  local key = frameName
  while parent ~= nil do
    local subKey = parent:GetDebugName()
    key = key .. '/' .. subKey
    parent = parent:GetParent()
  end

  return key
end

---@param frame Frame
---@return string
function profiling2.frameKey(frame)
  return profiling2.buildFrameKey(frame:GetDebugName(), frame:GetParent())
end

---check if script profiling is enabled
---@return boolean
local function isScriptProfilingEnabled()
    return C_CVar.GetCVarBool("scriptProfile") or false
end

---The index of the current frame. managed by an `OnUpdate` script
local frameIndex = 0
local currentEncounter = nil
local currentMythicPlus = nil
---Whether we are currently in a context that requires tracking. Generally false outside of raid/m+, true within.
local function trackingEnabled()
  return currentEncounter ~= nil or currentMythicPlus ~= nil
end

---@class ScriptTracker
---@field public heap TinyMinHeap
---@field public moments MomentEstimator
---@field public quantiles QuantileEstimator
---@field public total_time number
---@field public commits number The number of frame values committed. Should be equal to the number of frames in which the tracked method was called.
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
  self.heap:clear()
end

local trackerMeta = {
  __index = trackerBase
}

---@return ScriptTracker
local function getScriptTracker()
  local tracker = {
    heap = ns.heap.new(5),
    moments = ns.moment_estimator.new(),
    quantiles = ns.quantile.new(),
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

local function hookCreateFrame()
  local function hookSetScript(frame, scriptType, fn, alreadyInstrumented)
    local name = frame:GetName()
    local parent = frame:GetParent()
    if (frame.IsTopLevel and frame:IsToplevel())
      or (frame.IsForbidden and frame:IsForbidden())
      or (frame.IsProtected and frame:IsProtected())
      or (name ~= nil and string.match(name, "Blizzard") ~= nil)
      or (parent ~= nil and parent:GetDebugName() == "NamePlateDriverFrame")
      or name == "NamePlateDriverFrame" then
      -- print("skipping frame hook")
      return
    end
    if fn == nil or alreadyInstrumented then
      return
    end

    local frameKey = profiling2.frameKey(frame)
    -- print('hooking frame: ' .. frameKey)

    local tracker = getScriptTracker()
    local wrappedFn = function(...) fn(...) end
    local key = strjoin(':', frameKey, scriptType)
    profiling2.registerFunction(key, wrappedFn, tracker)

    frame:SetScript(scriptType, function(...)
      local startTime = debugprofilestop()
      local status, err = pcall(wrappedFn, ...)
      local endTime = debugprofilestop()

      tracker:record(endTime - startTime)
      if not status then
        DevTools_Dump({
          frame = frameKey,
          err = err,
          loc = "callsite"
        })
      end
    end, true)
  end

  local dummyFrame = CreateFrame("Frame")
  local dummyAnimGroup = dummyFrame:CreateAnimationGroup()
  local dummyAnim = dummyAnimGroup:CreateAnimation()
  local function hookmetatable(object)
    local frameIndex = getmetatable(object).__index
    hooksecurefunc(frameIndex, 'SetScript', hookSetScript)
  end
  hookmetatable(dummyFrame)
  hookmetatable(dummyAnim)
  hookmetatable(dummyAnimGroup)
end

---@class TrackedFn
---@field public fn function
---@field public tracker ScriptTracker

---@type table<string, TrackedFn>
local trackedFunctions = {}

---add a function to be tracked
---@param key string
---@param fn function
---@param tracker ScriptTracker
function profiling2.registerFunction(key, fn, tracker)
  trackedFunctions[key] = {
    fn = fn,
    tracker = tracker,
  }
end

function profiling2.buildUsageTable()
  local scripts = {}
  for key, value in pairs(trackedFunctions) do
    if value.tracker:shouldExport() then
      scripts[key] = value.tracker:export()
      scripts[key].officialTime = GetFunctionCPUUsage(value.fn, true)
    end
  end
  local results = {
    scripts = scripts
  }

  return results
end

function profiling2.resetTrackers()
  for _, value in ipairs(trackedFunctions) do
    value.tracker:reset()
  end
end

function profiling2.startEncounter(encounterId, encounterName, difficultyId, groupSize)
  if currentMythicPlus ~= nil then
    return
  end
  profiling2.resetTrackers()
  ResetCPUUsage()
  currentEncounter = {
    kind = "raid",
    encounterId = encounterId,
    encounterName = encounterName,
    difficultyId = difficultyId,
    groupSize = groupSize,
    startTime = time()
  }
end

function profiling2.encounterEnd(encounterID, encounterName, difficultyID, groupSize, success)
  if currentEncounter == nil then
    -- don't do anything if we didn't see the encounter start. a mid-combat reload probably happened or we're in a key
    return
  end
  currentEncounter.success = success == 1
  currentEncounter.endTime = time()

  table.insert(Profiling2_Storage.recordings, {
    encounter = currentEncounter,
    data = profiling2.buildUsageTable()
  })
  profiling2.resetTrackers()
  currentEncounter = nil
end

---@param mapId number
function profiling2.startMythicPlus(mapId)
  profiling2.resetState()
  ResetCPUUsage()
  currentMythicPlus = {
    kind = "mythicplus",
    mapId = mapId,
    groupSize = 5,
    startTime = time()
  }
end

-- manual start/stop methods for testing in town
function Profiling2Start()
  profiling2.resetTrackers()
  ResetCPUUsage()
  currentEncounter = {
    kind = "manual",
    startTime = time()
  }
end

function Profiling2End()
  if currentEncounter == nil then
    -- we didn't start an encounter
    return
  end
  currentEncounter.endTime = time()

  table.insert(Profiling2_Storage.recordings, {
    encounter = currentEncounter,
    data = profiling2.buildUsageTable()
  })
  profiling2.resetTrackers()
  currentEncounter = nil
end

---@param isCompletion boolean
---@param mapId number|nil
function profiling2.endMythicPlus(isCompletion, mapId)
  if currentMythicPlus == nil then
    return
  end

  currentMythicPlus.success = isCompletion
  currentMythicPlus.endTime = time()
  table.insert(profiling2.recordings, {
    encounter = currentMythicPlus,
    data = profiling2.buildUsageTable()
  })
  profiling2.resetState()
  currentMythicPlus = nil
end

if isScriptProfilingEnabled() then
  local frame = CreateFrame("Frame", "Profiling2_Frame")
  frame:RegisterEvent("ENCOUNTER_START")
  frame:RegisterEvent("ENCOUNTER_END")
  frame:RegisterEvent("ADDON_LOADED")
  frame:RegisterEvent("CHALLENGE_MODE_START")
  frame:RegisterEvent("CHALLENGE_MODE_COMPLETED")
  frame:RegisterEvent("CHALLENGE_MODE_RESET")
  frame:SetScript("OnUpdate", function()
    frameIndex = frameIndex + 1
  end)
  frame:SetScript("OnEvent", function(_, eventName, ...)
    if eventName == "ENCOUNTER_START" then
      profiling2.startEncounter(...)
    elseif eventName == "ENCOUNTER_END" then
      profiling2.encounterEnd(...)
    elseif eventName == "CHALLENGE_MODE_START" then
      profiling2.startMythicPlus(...)
    elseif eventName == "CHALLENGE_MODE_COMPLETED" or eventName == "CHALLENGE_MODE_RESET" then
      profiling2.endMythicPlus(eventName == "CHALLENGE_MODE_COMPLETED", ...)
    elseif eventName == "ADDON_LOADED" then
      local addonName = ...
      if addonName == "Profiling2" then
        ---@type table
        Profiling2_Storage = Profiling2_Storage or { recordings = {} }
        hookCreateFrame()
      end
    end
  end)
end
