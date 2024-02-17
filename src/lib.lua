---@class ProfilingNs
---@field public heap HeapNs
---@field public tracker TrackerNs
---@field public external Profiling2
---@field public sketch SketchNs
local ns = select(2, ...)

---@type string
local thisAddonName = select(1, ...)
---@class Profiling2CoreNs
local profiling2 = {}
ns.core = profiling2
local LibDeflate = LibStub("LibDeflate")
local LibSerialize = LibStub("LibSerialize")

local addonVersion = GetAddOnMetadata and GetAddOnMetadata(thisAddonName, "Version") or "unknown"

---Get the name of the frame for path construction. Uses GetName if possible, falls back to GetDebugName if unset.
---@param frame Frame|ParentedObject
---@return string
local function frameName(frame)
  local name = frame:GetName()
  if name == nil or #name == 0 then
    local debugName = frame:GetDebugName()
    if debugName == nil or #debugName  == 0 then
      return tostring(frame)
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

  local key = name
  while parent ~= nil do
    local subKey = frameName(parent)
    key = subKey .. '/' .. key
    parent = parent:GetParent()
  end
  key = '@' .. addonName .. '/' .. key

  return key
end

---@param frame any
---@return string
function profiling2.addonName(frame)
  local name = select(2, issecurevariable({ frame = frame }, 'frame')) or 'Unknown'

  -- blizzard frames will return our own addon name because we built the table.
  -- all Profiling2 frames have the addon name in the frame name and a frame name set,
  -- so they are easily identifiable without this
  if name == thisAddonName then
    return 'Unknown'
  end

  return name
end

function ns.isProbablyBlizzardFrame(frame)
  local issecure, name = issecurevariable({ frame = frame }, 'frame')
  return issecure or name == thisAddonName or name == "*** ForceTaint_Strong ***"
end

---@param frame Frame
---@return string
function profiling2.frameKey(frame)
  return profiling2.buildFrameKey(profiling2.addonName(frame), frameName(frame), frame:GetParent())
end

---check if script profiling is enabled
---@return boolean
function ns.isScriptProfilingEnabled()
    return C_CVar.GetCVarBool("scriptProfile") or false
end

local instrumentedCount = 0
function profiling2.buildWrapper(tracker, wrappedFn)
  local function result(...)
    local startTime = debugprofilestop()
    local result = {securecallfunction(wrappedFn, ...)}
    local endTime = debugprofilestop()

    tracker:record(endTime - startTime)
    return unpack(result)
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

local function captureSetScriptSource(frame)
  local name = frame:GetName()
  if name ~= nil and #name > 0 then
    return
  end

  return debugstack(4)
end

local function hookCreateFrame()
  local OrigSetScript = {}
  local function hookSetScript(frame, scriptType, fn)
    local name = frame:GetName()
    local parent = frame:GetParent()
    if (frame.IsForbidden and frame:IsForbidden())
      -- or (frame.IsProtected and frame:IsProtected())
      or (name ~= nil and string.match(name, "Blizzard") ~= nil)
      or (parent == PingFrame) -- workaround for ping frame
      or (parent ~= nil and parent:GetDebugName() == "NamePlateDriverFrame")
      -- workaround for the CastSequenceManager frame, which is lazily created
      -- after we hook and neither forbidden, protected, top-level, or named
      or (frame.elapsed ~= nil)
      or ns.isProbablyBlizzardFrame(frame)
      or name == "NamePlateDriverFrame" then
      -- print("skipping frame hook")
      return
    end
    if fn == nil then
      return
    end

    local sourceLine = nil
    if scriptType == "OnUpdate" or scriptType == "OnEvent" then
      sourceLine = captureSetScriptSource(frame)
    end
    local frameKey = profiling2.frameKey(frame)
    if sourceLine ~= nil then
      frameKey = frameKey .. '/dec:' .. LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(sourceLine))
    end
    local key = strjoin(':', frameKey, scriptType)
    -- print('hooking frame: ' .. frameKey)

    local tracker = ns.tracker.getFrameScriptTracker(frame, scriptType)
    local wrappedFn = function(...) fn(...) end
    profiling2.registerFunction(key, wrappedFn, tracker)

    local scriptWrapper = profiling2.buildWrapper(tracker, wrappedFn)

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
---@type table<string, TrackedFn>
local trackedExternals = {}

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

---add an external function to be tracked
---@param key string
---@param fn function
---@param tracker ScriptTracker
function profiling2.registerExternalFunction(key, fn, tracker)
  trackedExternals[key] = {
    fn = fn,
    tracker = tracker,
  }
end

function P2_GetTrackers()
  return { script = trackedFunctions, external = trackedExternals }
end

local renderTracker = ns.tracker.getScriptTracker()

function renderTracker:renderCount()
  return self.commits
end

local function buildInternalUsageTable(trackedMap)
  local scripts = {}
  for key, value in pairs(trackedMap) do
    if value.tracker:shouldExport() then
      scripts[key] = value.tracker:export()
    end
  end

  return scripts
end

function profiling2.buildUsageTable()
  local results = {
    onUpdateDelay = renderTracker:export(),
    scripts = buildInternalUsageTable(trackedFunctions),
    externals = buildInternalUsageTable(trackedExternals),
    sketch_params = ns.sketch.params,
  }

  return results
end

local function resetAll(trackedMap)
  for _, value in pairs(trackedMap) do
    value.tracker:reset()
  end
end

function profiling2.resetTrackers()
  resetAll(trackedFunctions)
  resetAll(trackedExternals)
  renderTracker:reset()
end

function profiling2.startEncounter(encounterId, encounterName, difficultyId, groupSize)
  if ns.tracker.isEncounterInProgress() then
    return
  end
  profiling2.resetTrackers()
  ResetCPUUsage()
  ns.tracker.setEncounter({
    kind = "raid",
    encounterId = encounterId,
    encounterName = encounterName,
    difficultyId = difficultyId,
    groupSize = groupSize,
    startTime = time()
  })
end

local MAX_RECORDINGS = 50

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

    -- we only serialize and compress the data table. this allows us to skip decompression when
    -- handling the data in the browser, using the encounter table as metadata to determine what the
    -- user wants to load
    local serialized = LibSerialize:Serialize(recording.data)
    local compressed = LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(serialized))
    table.insert(Profiling2_Storage.recordings, {
      encounter = recording.encounter,
      version = addonVersion,
      data = compressed,
    })
  end)
end

function profiling2.encounterEnd(encounterID, encounterName, difficultyID, groupSize, success)
  local currentEncounter = ns.tracker.getCurrentEncounter()
  if currentEncounter == nil or ns.tracker.isMythicPlusActive() then
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
  ns.tracker.setEncounter(nil)
end

---@param mapId number
function profiling2.startMythicPlus(mapId)
  profiling2.resetTrackers()
  ResetCPUUsage()
  ns.tracker.setMythicPlus({
    kind = "mythicplus",
    mapId = mapId,
    groupSize = 5,
    startTime = time()
  })
end

-- manual start/stop methods for testing in town
function ns.start()
  profiling2.resetTrackers()
  ResetCPUUsage()
  ns.tracker.setEncounter({
    kind = "manual",
    startTime = time()
  })
end

function ns.stop()
  local currentEncounter = ns.tracker.getCurrentEncounter()
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
  ns.tracker.setEncounter(nil)
end

---@param isCompletion boolean
---@param mapId number|nil
function profiling2.endMythicPlus(isCompletion, mapId)
  local currentMythicPlus = ns.tracker.getCurrentEncounter()
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
  ns.tracker.setMythicPlus(nil)
end

function ns.printStatus()
  print("Profiling2 Status: " .. (ns.tracker.isEncounterInProgress() and "|cff00ff00Recording Data|r" or "|cffff0000Not Currently Recording|r"))
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
    renderTracker:record(elapsed * 1000)
    ns.tracker.nextFrame()
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
