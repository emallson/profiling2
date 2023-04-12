local newHeap = require('heap')

assert:register("assertion", "leq", function(_, arguments) return arguments[1] <= arguments[2] end)
assert:register("assertion", "geq", function(_, arguments) return arguments[1] >= arguments[2] end)

describe("min heap", function()
  it("should allow pushing a single value", function()
    local heap = newHeap(5)
    assert.is_nil(heap:top())
    assert.is_true(heap:is_empty())
    heap:push(1)
    assert.are.equal(1, heap:top())
    assert.is_false(heap:is_empty())
  end)

  it('should preserve the min property on repeated pushes', function()
    local heap = newHeap(5)
    local values = {5, 3, 27, 2, 7}

    local min = 1000
    for _, value in ipairs(values) do
      if min > value then
        value = min
      end
      heap:push(value)
      assert.are.equal(min, heap:top())
    end
  end)

  it('should preserve the min property on repeated pops', function()
    local heap = newHeap(5)
    local values = {5, 3, 27, 2, 7}

    for _, value in ipairs(values) do
      heap:push(value)
    end

    while not heap:is_empty() do
      local prev = heap:pop()
      local next = heap:top()
      if next ~= nil then
        assert.are.leq(prev, next)
      end
    end
  end)

  it('should limit the heap size, popping when necessary', function()
    local heap = newHeap(5)
    local values = {5, 3, 27, 2, 7, 32, 27, 1, 3, 100}

    for _, value in ipairs(values) do
      heap:push(value)
    end

    local actual_size = 0
    while not heap:is_empty() do
      heap:pop()
      actual_size = actual_size + 1
    end

    assert.are.equal(5, actual_size)
  end)

  it('should preserve the min property when pushpopping past max capacity', function()
    local heap = newHeap(5)
    local values = {5, 3, 27, 2, 7, 32, 27, 1, 3, 100}

    for _, value in ipairs(values) do
      heap:push(value)
    end


    while not heap:is_empty() do
      local prev = heap:pop()
      local next = heap:top()
      if next ~= nil then
        assert.are.leq(prev, next)
      end
    end
  end)

  it('should have acceptable performance', function()
    math.randomseed(os.time())

    local RENDERS = 1000
    -- we can handle over 1000 frame updates per second with the current code
    local FRAMES = 1000

    local heaps = {}
    for _ = 1, FRAMES do
      table.insert(heaps, newHeap(5))
    end

    local starttime = os.clock()
    for _ = 1, RENDERS do
      local value = math.random()
      for _, heap in ipairs(heaps) do
        heap:push(value)
      end
    end
    local endtime = os.clock()

    local SIXTY_FPS = 1 / 60
    local TARGET = SIXTY_FPS / 100 * RENDERS
    local actual = endtime - starttime
    assert.are.geq(TARGET, actual)
  end)
end)
