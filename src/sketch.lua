---Implementation of mixed-mode distribution sketching. This implementation has 3 modalities:
---
---1. "Trivial" runs. Anything less than a fixed T value in run time gets thrown into a simple
---   counter.
---
---2. Top-end outliers. We build on the min-k heap in ./heap to track k exact outliers at the top
---   end.
---
---3. The body of the distribution. We build on the DDSketch approach for this because it is easy
---   to implement and well-suited to the constraints of this project.

---@type ProfilingNs
local ns = select(2, ...)

-- parameters for DDSketch
local alpha = 0.05
local gamma = (1.0 + alpha) / (1.0 - alpha)
-- we calculate a fixed offset for the bin calculation function that is used to shift bins onto the
-- 1..n range that gets the array-table fast path in Lua.
local target_T = 0.5
local bin_offset = math.ceil(math.log(target_T, gamma))
local T = math.pow(gamma, bin_offset)
local k = 10

---Compute the bin index. `obs > T` is assumed.
---@param obs number
---@return number
local function bin_index(obs)
  return math.ceil(math.log(obs, gamma)) - bin_offset
end

---Pre-built storage tables for mode 3. We build a number of these on load to avoid additional latency during
---runs. They may be claimed by sketches during runtime, and we are only forced to build from
---scratch once this pool is empty, and are only rarely forced to convert the bin table to a mixed
---format.
---
---This has positive impacts both on latency and total memory usage, since *almost all* scripts
---have fewer than k observations above T.
---@type table<table<number>>
local dist_storage_pool = {}

---Default size of tables in the pool.
local pool_table_size = bin_index(100)
local pool_size = 100

---@return table<number>
local function build_bins()
  local result = {}
  result[pool_table_size] = 0
  for i = 1, pool_table_size - 1 do
    result[i] = 0
  end
  return result
end

for _ = 1, pool_size do
  table.insert(dist_storage_pool, build_bins())
end


---@class Sketch
---@field private count number
---@field private trivial_count number
---@field private bins table<number>|nil
---@field private outliers TinyMinHeap Maybe not actual outliers, but the top k.
local sketchBase = {
  ---The cutoff for trivial values.
  T = T,
  ---Compute the bin index for a value
  bin_index = bin_index,
}

local meta = { __index = sketchBase }

---Create a new Sketch
---@param newHeap function|nil A way for tests to inject the heap constructor
---@return Sketch
local function new(newHeap)
  local result = {
    count = 0,
    trivial_count = 0,
    bins = nil,
    outliers = (newHeap or ns.heap.new)(k)
  }
  setmetatable(result, meta)

  return result
end

---Number of observed (not stored) samples
---@return number
function sketchBase:obs_count()
  return self.count
end

---Record a new observation
---@param obs number
function sketchBase:push(obs)
  self.count = self.count + 1
  if obs <= T then
    self.trivial_count = self.trivial_count + 1
  else
    local old = self.outliers:push(obs)
    if old ~= nil then
      local bins = self:acquire_bins()
      local ix = bin_index(old)
      bins[ix] = (bins[ix] or 0) + 1
    end
  end
end

---Retrieve a bin table from the pool if possible. Otherwise, initialize one.
---@private
---@return table<number>
function sketchBase:acquire_bins()
  if self.bins ~= nil then
    return self.bins
  elseif #dist_storage_pool > 0 then
    self.bins = table.remove(dist_storage_pool)
    return self.bins
  else
    self.bins = build_bins()
    return self.bins
  end
end

function sketchBase:reset()
  self.count = 0
  self.trivial_count = 0
  if self.bins ~= nil then
    for ix, _ in pairs(self.bins) do
      self.bins[ix] = 0
    end
  end
  self.outliers:clear()
end

---Make a copy of the data stored within for exporting.
---@return table
function sketchBase:export()
  local result = {
    count = self.count,
    trivial_count = self.trivial_count,
    outliers = self.outliers:contents()
  }

  if self.bins ~= nil then
    result.bins = {}
    for ix, v in pairs(self.bins) do
      result.bins[ix] = v
    end
  end

  return result
end

if type(ns) == 'table' then
  ---@class SketchNs
  local sketchNs = {
    new = new,
    params = {
      trivial_cutoff = T,
      alpha = alpha,
      gamma = gamma,
      bin_offset = bin_offset,
    }
  }

  ns.sketch = sketchNs
end

return new
