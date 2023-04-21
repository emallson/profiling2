---@class ProfilingNs
---@field public heap HeapNs
---@field public moment_estimator MomentEstimatorNs
---@field public quantile QuantileNs
---@field public reservoir ReservoirNs
local ns = select(2, ...)

---@type string
local thisAddonName = select(1, ...)
local profiling2 = {}

---Get the name of the frame for path construction. Uses GetName if possible, falls back to GetDebugName if unset.
---@param frame Frame|ParentedObject
---@return string
local function frameName(frame)
  local name = frame:GetName()
  if name == nil or #name == 0 then
    local debugName = frame:GetDebugName()
    if debugName == nil or #debugName  == 0 then
      return "Anonymous"
    end
    return string.match(debugName, "[^%.]+$")
  end
  return name
end

---@param addonName string
---@param name string
---@param origParent Frame|ParentedObject
---@return string
function profiling2.buildFrameKey(addonName, name, origParent)
  local parent = origParent

  local key = '@' .. addonName .. '/' .. name
  while parent ~= nil do
    local subKey = frameName(parent)
    key = key .. '/' .. subKey
    parent = parent:GetParent()
  end

  return key
end

---@param frame Frame
---@return string
local function addonName(frame)
  local name = select(2, issecurevariable({ frame = frame }, 'frame')) or 'Unknown'

  -- blizzard frames will return our own addon name because we built the table.
  -- all Profiling2 frames have the addon name in the frame name and a frame name set,
  -- so they are easily identifiable without this
  if name == thisAddonName then
    return 'Unknown'
  end

  return name
end

local function isProbablyBlizzardFrame(frame)
  local issecure, name = issecurevariable({ frame = frame }, 'frame')
  return issecure or name == thisAddonName or name == "*** ForceTaint_Strong ***"
end

---@param frame Frame
---@return string
function profiling2.frameKey(frame)
  return profiling2.buildFrameKey(addonName(frame), frameName(frame), frame:GetParent())
end

---check if script profiling is enabled
---@return boolean
function ns.isScriptProfilingEnabled()
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
local function getScriptTracker(frame, scriptType)
  if frame and trackers[frame] and trackers[frame][scriptType] then
    return trackers[frame][scriptType]
  end
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

  if frame and scriptType then
    trackers[frame] = trackers[frame] or {}
    trackers[frame][scriptType] = tracker
  end

  return tracker
end

local instrumentedCount = 0
local function buildWrapper(tracker, wrappedFn)
  local function result(...)
    local startTime = debugprofilestop()
    securecallfunction(wrappedFn, ...)
    local endTime = debugprofilestop()

    tracker:record(endTime - startTime)
  end

  instrumentedCount = instrumentedCount + 1
  return result
end

local OBJECT_TYPES = {
  'Frame',
  'ArchaeologyDigSiteFrame',
  'Browser',
  'CheckButton',
  'Checkout',
  'CinematicModel',
  'ColorSelect',
  'Cooldown',
  'DressUpModel',
  -- hooking editbox disables the chat boxes
  -- probably not very combat relevant anyway
  -- 'EditBox',
  'FogOfWarFrame',
  'GameTooltip',
  'MessageFrame',
  'Model',
  'ModelScene',
  'MovieFrame',
  'OffScreenFrame',
  'PlayerModel',
  'QuestPOIFrame',
  'ScenarioPOIFrame',
  'ScrollFrame',
  'SimpleHTML',
  'Slider',
  'StatusBar',
  'TabardModel',
  'UnitPositionFrame',
}

local function hookCreateFrame()
  local OrigSetScript = {}
  local function hookSetScript(frame, scriptType, fn)
    local name = frame:GetName()
    local parent = frame:GetParent()
    if (frame.IsTopLevel and frame:IsToplevel())
      or (frame.IsForbidden and frame:IsForbidden())
      or (frame.IsProtected and frame:IsProtected())
      or (name ~= nil and string.match(name, "Blizzard") ~= nil)
      or (parent ~= nil and parent:GetDebugName() == "NamePlateDriverFrame")
      -- workaround for the CastSequenceManager frame, which is lazily created
      -- after we hook and neither forbidden, protected, top-level, or named
      or (frame.elapsed ~= nil)
      or isProbablyBlizzardFrame(frame)
      or name == "NamePlateDriverFrame" then
      -- print("skipping frame hook")
      return
    end
    if fn == nil then
      return
    end

    local frameKey = profiling2.frameKey(frame)
    local key = strjoin(':', frameKey, scriptType)
    -- print('hooking frame: ' .. frameKey)

    local tracker = getScriptTracker(frame, scriptType)
    local wrappedFn = function(...) fn(...) end
    profiling2.registerFunction(key, wrappedFn, tracker)

    local scriptWrapper = buildWrapper(tracker, wrappedFn)

    -- we use the original SetScript method to avoid triggering loops
    -- hooksecurefunc(t, f, h) basically works by replacing t[f] with 
    -- `local f = t[f]; function (...) local r = f(...); h(...) return r end`
    --
    -- normally, when this is done the real `f` is still on the metatable __index
    -- ...but we overwrite that by calling hooksecurefunc with the metatable __index as `t`
    --
    -- anyway, point being that we keep the original `f` around and use it here to 
    -- avoid recursion because otherwise we basically have `h = function(...) h(...) end` 
    -- and that doesn't end well
    --
    -- this also sidesteps several issues with other addons hooking `SetScript` 
    -- with their own recursive hooks (ElvUI and LibQTip both do this). By using the 
    -- original, pristine `f` we prevent this call from triggering ANY hooks.
    OrigSetScript[frame:GetObjectType()](frame, scriptType, scriptWrapper)
  end

  local dummyFrame = CreateFrame("Frame")
  local dummyAnimGroup = dummyFrame:CreateAnimationGroup()
  local dummyAnim = dummyAnimGroup:CreateAnimation()
  local function hookmetatable(object)
    local frameIndex = getmetatable(object).__index
    OrigSetScript[object:GetObjectType()] = frameIndex.SetScript
    hooksecurefunc(frameIndex, 'SetScript', hookSetScript)
  end
  hookmetatable(dummyAnim)
  hookmetatable(dummyAnimGroup)
  for _, type in ipairs(OBJECT_TYPES) do
    hookmetatable(CreateFrame(type))
  end
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

local renderTracker = getScriptTracker()

function renderTracker:renderCount()
  return self.commits
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
    onUpdateDelay = renderTracker:export(),
    scripts = scripts
  }

  return results
end

function profiling2.resetTrackers()
  for _, value in ipairs(trackedFunctions) do
    value.tracker:reset()
  end
  renderTracker:reset()
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

local MAX_RECORDINGS = 50
local LibDeflate = LibStub("LibDeflate")
local LibSerialize = LibStub("LibSerialize")

---@class Recording
---@field encounter table
---@field data table

---@param recording Recording
local function insertRecording(recording)
  local timer
  timer = C_Timer.NewTicker(1, function()
    if InCombatLockdown() then
      -- don't attempt to store data while in combat because serialization can trigger the "script
      -- took too long" error. we have much greater limitations outside of combat. The encounter end
      -- and CM completion events can fire while still in combat
      return
    end

    -- stop the timer before we attempt anything. this is to prevent an infinite loop if
    -- serialization fails
    --
    -- would rather lose data than brick the game
    timer:Cancel()

    -- prune the recording table
    while #Profiling2_Storage.recordings >= MAX_RECORDINGS do
      table.remove(Profiling2_Storage.recordings, 1)
    end

    -- record both for now to compare compressed size offline.
    -- initial results indicate that serialization + compression is MUCH better than the naive
    -- output
    table.insert(Profiling2_Storage.recordings, recording)

    -- we only serialize and compress the data table. this allows us to skip decompression when
    -- handling the data in the browser, using the encounter table as metadata to determine what the
    -- user wants to load
    local serialized = LibSerialize:Serialize(recording.data)
    local compressed = LibDeflate:CompressDeflate(serialized)
    table.insert(Profiling2_Storage.recordings, {
      encounter = recording.encounter,
      data = compressed,
    })
  end)
end

function profiling2.encounterEnd(encounterID, encounterName, difficultyID, groupSize, success)
  if currentEncounter == nil then
    -- don't do anything if we didn't see the encounter start. a mid-combat reload probably happened or we're in a key
    return
  end
  currentEncounter.success = success == 1
  currentEncounter.endTime = time()

  insertRecording({
    encounter = currentEncounter,
    data = profiling2.buildUsageTable()
  })
  profiling2.resetTrackers()
  currentEncounter = nil
end

---@param mapId number
function profiling2.startMythicPlus(mapId)
  profiling2.resetTrackers()
  ResetCPUUsage()
  currentMythicPlus = {
    kind = "mythicplus",
    mapId = mapId,
    groupSize = 5,
    startTime = time()
  }
end

-- manual start/stop methods for testing in town
function ns.start()
  profiling2.resetTrackers()
  ResetCPUUsage()
  currentEncounter = {
    kind = "manual",
    startTime = time()
  }
end

function ns.stop()
  if currentEncounter == nil then
    -- we didn't start an encounter
    return
  end
  currentEncounter.endTime = time()

  insertRecording({
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
  insertRecording({
    encounter = currentMythicPlus,
    data = profiling2.buildUsageTable()
  })
  profiling2.resetTrackers()
  currentMythicPlus = nil
end

function ns.printStatus()
  print("Profiling2 Status: " .. ((currentEncounter or currentMythicPlus) and "|cff00ff00Active|r" or "|cffff0000Inactive|r"))
  print("scriptProfile CVar Status: " .. (ns.isScriptProfilingEnabled() and "|cff00ff00On|r" or "|cffff0000Off|r"))
  print("Instrumented Scripts: " .. instrumentedCount)
  print("Renders Recorded: " .. renderTracker:renderCount())
end

if ns.isScriptProfilingEnabled() then
  local frame = CreateFrame("Frame", "Profiling2_Frame")
  frame:RegisterEvent("ENCOUNTER_START")
  frame:RegisterEvent("ENCOUNTER_END")
  frame:RegisterEvent("ADDON_LOADED")
  frame:RegisterEvent("CHALLENGE_MODE_START")
  frame:RegisterEvent("CHALLENGE_MODE_COMPLETED")
  frame:RegisterEvent("CHALLENGE_MODE_RESET")
  frame:SetScript("OnUpdate", function(_, elapsed)
    renderTracker:record(elapsed)
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
      local loadedAddonName = ...
      if loadedAddonName == thisAddonName then
        ---@type table
        Profiling2_Storage = Profiling2_Storage or { recordings = {} }
      end
    end
  end)

  hookCreateFrame()
end
