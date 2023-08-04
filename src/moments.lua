---@type ProfilingNs
local ns = select(2, ...)

---@class MomentEstimator
---@field private index number
local estimator = {}

local meta = {
  __index = estimator
}

-- we use bump allocation for this because it performs *much* better with large numbers of estimators
-- 
-- i would like kurtosis as well, but it limits the amount of frames we can handle without a perf drop
local m1_arena = {}
local m2_arena = {}
local m3_arena = {}
local samples_arena = {}

---@return MomentEstimator
local function newEstimator()
  table.insert(m1_arena, 0)
  table.insert(m2_arena, 0)
  table.insert(m3_arena, 0)
  table.insert(samples_arena, 0)
  local index = #m1_arena
  local result = {
    index = index
  }

  setmetatable(result, meta)

  return result
end

---@param sample number
function estimator:update(sample)
  local mean = m1_arena[self.index]
  local samples = samples_arena[self.index]
  local delta = sample - mean
  local n = samples + 1
  local sDelta = delta / n
  local newMean = mean + sDelta

  if samples >= 2 then
    local m3 = m3_arena[self.index]
    local m2 = m2_arena[self.index]
    m3_arena[self.index] = m3 + sDelta * (-3 * m2  + samples * (samples - 1) * sDelta * delta)
    m2_arena[self.index] = m2 + delta * (sample - newMean)
  end

  m1_arena[self.index] = newMean
  samples_arena[self.index] = n
end

---@return number
function estimator:mean()
  return m1_arena[self.index]
end

---@return number
function estimator:sample_count()
  return samples_arena[self.index]
end

function estimator:variance()
  return m2_arena[self.index] / (samples_arena[self.index] - 1)
end

function estimator:skewness()
  local scale = math.sqrt(samples_arena[self.index])
  return m3_arena[self.index] * scale / math.pow(m2_arena[self.index], 1.5)
end

function estimator:reset()
  m1_arena[self.index] = 0
  m2_arena[self.index] = 0
  m3_arena[self.index] = 0
  samples_arena[self.index] = 0
end

if type(ns) == 'table' then
  ---@class MomentEstimatorNs
  local estimatorNs = {
    new = newEstimator
  }
  ns.moment_estimator = estimatorNs
end

return newEstimator
