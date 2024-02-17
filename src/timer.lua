local ns = select(2, ...)
local LibDeflate = LibStub("LibDeflate")

local trackers = {}

local function getTimerTracker(key)
  if trackers[key] == nil then
    trackers[key] = ns.tracker.getScriptTracker(false)
  end

  return trackers[key]
end

local function wrapTimer(methodName)
  if not ns.isScriptProfilingEnabled() then
    -- don't wrap timer methods when script profiling is off
    return
  end
  local oldMethod = C_Timer[methodName]
  C_Timer[methodName] = function(seconds, callback, ...)
    if ns.isProbablyBlizzardFrame(callback) then
      return oldMethod(seconds, callback, ...)
    end

    local sourceLine = debugstack(4)
    local key = "/unknown"
    if sourceLine ~= nil then
      key = '/dec:' .. LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(sourceLine))
    end
    local addonName = ns.core.addonName(callback)
    local path = '@' .. addonName .. '/Timers/' .. methodName .. key .. ':Timer'
    local tracker = getTimerTracker(path)

    ns.core.registerFunction(path, callback, tracker)
    local wrapped = ns.core.buildWrapper(tracker, callback)
    return oldMethod(seconds, wrapped, ...)
  end
end

wrapTimer("After")
wrapTimer("NewTimer")
wrapTimer("NewTicker")
