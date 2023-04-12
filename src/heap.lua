local _, ns = ...

---@class TinyMinHeap
---@field private values number[]
---@field private maxSize number
local tinyMinHeap = {}

local meta = {
    __index = tinyMinHeap
  }

---@return TinyMinHeap
local function newHeap(size)
  local result = {
    maxSize = size,
    values = {},
  }
  setmetatable(result, meta)
  return result
end

function tinyMinHeap:is_empty()
  return #self.values == 0
end

---@private
---@param value number
---@return number
function tinyMinHeap:pushpop(value)
  if self.values[1] >= value then
    return value
  end

  local old = self.values[1]
  self.values[1] = value
  self:downheap(1)
  return old
end

---@private
---@param ix number
function tinyMinHeap:downheap(ix)
  while true do
    local left = ix * 2
    local right = left + 1

    local side
    if self.values[ix] == nil then
      break
    elseif self.values[left] ~= nil and self.values[right] ~= nil then
      -- we have to decide between the left and the right branch
      side = self.values[left] < self.values[right] and left or right
      if self.values[side] >= self.values[ix] then
        -- both sides satisfy the min heap property
        break
      end
    elseif self.values[left] ~= nil and self.values[ix] > self.values[left] then
      side = left
    elseif self.values[right] ~= nil and self.values[ix] > self.values[right] then
      side = right
    else
      break
    end

    local next = self.values[ix]
    self.values[ix] = self.values[side]
    self.values[side] = next
    ix = side
  end
end

---@return number|nil
function tinyMinHeap:top()
  return self.values[1]
end

local function parent(index)
  return math.floor(index / 2)
end

---@param value number
---@return number|nil
function tinyMinHeap:push(value)
  if #self.values >= self.maxSize then
    return self:pushpop(value)
  else
    self.values[#self.values + 1] = value
    local ix = #self.values
    local p = parent(ix)
    while p > 0 do
      if self.values[p] > self.values[ix] then
        self.values[ix] = self.values[p]
        self.values[p] = value
        ix = p
        p = parent(p)
      else
        break
      end
    end
  end
end

---@return number|nil
function tinyMinHeap:pop()
  if #self.values < 1 then
    return nil
  end

  local result = self.values[1]
  self.values[1] = self.values[#self.values]
  self.values[#self.values] = nil
  self:downheap(1)
  return result
end

-- bind to addon namespace in addon context
if type(ns) == "table" then
  ns.heap = {
    new = newHeap
  }
end

return newHeap
