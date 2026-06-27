pub struct List<T> {
    head: Link<T>,
}

type Link<T> = Option<Box<Node<T>>>;

struct Node<T> {
    elem: T,
    next: Link<T>,
}

pub struct Iter<'a, T> {
    next: Option<&'a Node<T>>,
}

impl<T> List<T> {
    pub fn new() -> Self {
        List { head: None }
    }

    pub fn push_front(&mut self, elem: T) {
        let new_node = Box::new(Node {
            elem,
            next: self.head.take(),
        });

        self.head = Some(new_node);
    }

    pub fn pop_front(&mut self) -> Option<T> {
        self.head.take().map(|node| {
            self.head = node.next;
            node.elem
        })
    }

    pub fn peek(&self) -> Option<&T> {
        self.head.as_ref().map(|node| &node.elem)
    }

    pub fn peek_mut(&mut self) -> Option<&mut T> {
        self.head.as_mut().map(|node| &mut node.elem)
    }

    pub fn iter(&self) -> Iter<'_, T> {
        Iter {
            next: self.head.as_deref(),
        }
    }
}

impl<T> Drop for List<T> {
    fn drop(&mut self) {
        let mut current = self.head.take();

        while let Some(mut boxed_node) = current {
            current = boxed_node.next.take();
        }
    }
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        self.next.map(|node| {
            self.next = node.next.as_deref();
            &node.elem
        })
    }
}

fn main() {
    let mut list = List::new();

    println!("pop empty: {:?}", list.pop_front());

    list.push_front(1);
    list.push_front(2);
    list.push_front(3);

    println!("peek before mut: {:?}", list.peek());

    if let Some(value) = list.peek_mut() {
        *value = 30;
    }

    println!("peek after mut: {:?}", list.peek());

    let values: Vec<_> = list.iter().copied().collect();
    println!("iter values: {values:?}");

    println!("pop first: {:?}", list.pop_front());
    println!("pop second: {:?}", list.pop_front());
    println!("pop third: {:?}", list.pop_front());
    println!("pop empty: {:?}", list.pop_front());
}
